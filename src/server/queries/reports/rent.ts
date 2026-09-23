import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { addDays, today } from '@/domain/dates';
import { CONTRACT_STATUS_LABEL, type ContractStatusCode } from '@/domain/billing';
import { monthChart, monthRows, n, opt, revenueSql, type ReportDef, type Row } from './types';

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
/** Uređaj se naplaćuje ako nema vlastitog statusa ili je aktivan. */
const billableItem = Prisma.sql`(ci."status" IS NULL OR ci."status" = 'ACTIVE')`;

export const rentReports: ReportDef[] = [
  {
    slug: 'prihod-od-najma',
    title: 'Mjesečni prihod od najma',
    area: 'Najam',
    description: 'Neto prihod iz računa za najam po mjesecu izdavanja (umanjen za storna i odobrenja).',
    filters: ['year', 'partner'],
    run: async (companyId, f) => {
      const rows = await db.$queryRaw<Array<{ m: number; net: Prisma.Decimal; cnt: number; contracts: number }>>`
        SELECT EXTRACT(MONTH FROM i."date")::int AS m, SUM(i."netTotal") AS net,
               COUNT(*) FILTER (WHERE i."kind" = 'INVOICE')::int AS cnt, COUNT(DISTINCT i."contractId")::int AS contracts
        FROM "Invoice" i JOIN "Partner" p ON p.id = i."partnerId"
        WHERE ${revenueSql(companyId)} AND i."type" = 'RENT' AND i."year" = ${f.year}
          ${opt(!!f.partnerId, Prisma.sql`AND i."partnerId" = ${f.partnerId}`)}
        GROUP BY 1`;
      const out = monthRows(f.year, (m) => {
        const r = rows.find((x) => x.m === m);
        return { net: n(r?.net), invoices: r?.cnt ?? 0, contracts: r?.contracts ?? 0, avg: r?.cnt ? Math.round((n(r.net) / r.cnt) * 100) / 100 : null };
      });
      return {
        columns: [
          { key: 'month', label: 'Mjesec' },
          { key: 'invoices', label: 'Računa', kind: 'int' },
          { key: 'contracts', label: 'Ugovora', kind: 'int', sum: false },
          { key: 'net', label: 'Prihod', kind: 'money' },
          { key: 'avg', label: 'Prosjek po računu', kind: 'money', sum: false },
        ],
        rows: out,
        chart: monthChart(f.year, out, [{ key: 'net', label: 'Najam' }]),
      };
    },
  },
  {
    slug: 'aktivni-najmovi',
    title: 'Aktivni najmovi po klijentu',
    area: 'Najam',
    description: 'Aktivni ugovori po klijentu: broj uređaja i mjesečni najam koji se naplaćuje.',
    filters: [],
    run: async (companyId) => {
      const rows = await db.$queryRaw<Array<{ id: string; name: string; contracts: number; devices: number; monthly: Prisma.Decimal; since: Date; ends: Date | null }>>`
        SELECT p.id, p.name, COUNT(DISTINCT c.id)::int AS contracts, COUNT(ci.id)::int AS devices,
               COALESCE(SUM(ci."monthly") FILTER (WHERE ${billableItem}), 0) AS monthly,
               MIN(c."startDate") AS since, MIN(c."endDate") AS ends
        FROM "Contract" c
        JOIN "Partner" p ON p.id = c."partnerId"
        LEFT JOIN "ContractItem" ci ON ci."contractId" = c.id
        WHERE c."companyId" = ${companyId} AND c."status" = 'ACTIVE' AND p."excluded" = false
        GROUP BY p.id ORDER BY monthly DESC`;
      const out: Row[] = rows.map((r) => ({
        name: r.name, contracts: r.contracts, devices: r.devices, monthly: n(r.monthly), annual: Math.round(n(r.monthly) * 12 * 100) / 100,
        since: iso(r.since), ends: iso(r.ends), _href: `/partneri/${r.id}?tab=ugovori`,
      }));
      return {
        columns: [
          { key: 'name', label: 'Klijent' },
          { key: 'contracts', label: 'Ugovora', kind: 'int' },
          { key: 'devices', label: 'Uređaja', kind: 'int' },
          { key: 'monthly', label: 'Mjesečno', kind: 'money' },
          { key: 'annual', label: 'Godišnje', kind: 'money' },
          { key: 'since', label: 'Najam od', kind: 'date' },
          { key: 'ends', label: 'Prvi istek', kind: 'date' },
        ],
        rows: out,
        chart: { kind: 'hbar', title: 'Mjesečni najam po klijentu', rows: out.slice(0, 10).map((r) => ({ label: String(r.name), value: Number(r.monthly), href: r._href ?? undefined })) },
        note: 'Mjesečni iznos ne uključuje uređaje koji su na ugovoru pauzirani ili raskinuti.',
      };
    },
  },
  {
    slug: 'ugovori-istek',
    title: 'Ugovori — istek i obnova',
    area: 'Najam',
    description: 'Aktivni ugovori kojima kraj ističe u odabranom razdoblju (i oni kojima je kraj već prošao) — za obnovu ili povrat opreme.',
    filters: ['days'],
    defaultDays: 90,
    run: async (companyId, f) => {
      const now = today();
      const rows = await db.$queryRaw<Array<{ id: string; number: string; partner: string; status: ContractStatusCode; start: Date; ends: Date; left: number; devices: number; monthly: Prisma.Decimal }>>`
        SELECT c.id, c."number", p.name AS partner, c."status", c."startDate" AS start, c."endDate" AS ends,
               (c."endDate" - ${now}::date) AS left, COUNT(ci.id)::int AS devices,
               COALESCE(SUM(ci."monthly") FILTER (WHERE ${billableItem}), 0) AS monthly
        FROM "Contract" c
        JOIN "Partner" p ON p.id = c."partnerId"
        LEFT JOIN "ContractItem" ci ON ci."contractId" = c.id
        WHERE c."companyId" = ${companyId} AND c."status" IN ('ACTIVE','PAUSED') AND p."excluded" = false
          AND c."endDate" IS NOT NULL AND c."endDate" <= ${addDays(now, f.days)}::date
        GROUP BY c.id, p.name ORDER BY c."endDate"`;
      return {
        columns: [
          { key: 'number', label: 'Ugovor' },
          { key: 'partner', label: 'Klijent' },
          { key: 'status', label: 'Status' },
          { key: 'start', label: 'Početak', kind: 'date' },
          { key: 'ends', label: 'Kraj', kind: 'date' },
          { key: 'left', label: 'Do isteka', kind: 'days', sum: false },
          { key: 'devices', label: 'Uređaja', kind: 'int' },
          { key: 'monthly', label: 'Mjesečno', kind: 'money' },
        ],
        rows: rows.map((r) => ({
          number: r.number, partner: r.partner, status: r.left < 0 ? 'Istekao — još aktivan' : CONTRACT_STATUS_LABEL[r.status], start: iso(r.start), ends: iso(r.ends),
          left: r.left, devices: r.devices, monthly: n(r.monthly), _href: `/najam/ugovori/${r.id}`, _muted: r.left < 0 ? 'bad' : null,
        })),
        note: 'Negativan broj dana znači da je kraj ugovora prošao, a ugovor još nije zatvoren.',
      };
    },
  },
  {
    slug: 'nabava-po-dobavljacima',
    title: 'Nabava po dobavljačima',
    area: 'Nabava',
    description: 'Proknjižene primke u godini po dobavljaču: broj primki, zaprimljenih uređaja i nabavna vrijednost.',
    filters: ['year'],
    run: async (companyId, f) => {
      const rows = await db.$queryRaw<Array<{ id: string | null; name: string | null; receipts: number; devices: number; total: Prisma.Decimal; last: Date }>>`
        SELECT s.id, s.name, COUNT(*)::int AS receipts,
               COALESCE(SUM((SELECT COUNT(*) FROM "Item" it WHERE it."receiptId" = r.id)), 0)::int AS devices,
               SUM(r."total") AS total, MAX(r."date") AS last
        FROM "GoodsReceipt" r LEFT JOIN "Partner" s ON s.id = r."supplierId"
        WHERE r."companyId" = ${companyId} AND r."status" = 'POSTED' AND EXTRACT(YEAR FROM r."date") = ${f.year}
          AND (s.id IS NULL OR s."excluded" = false)
        GROUP BY s.id ORDER BY total DESC`;
      const sum = rows.reduce((a, r) => a + n(r.total), 0);
      const out: Row[] = rows.map((r) => ({
        name: r.name ?? 'Bez dobavljača', receipts: r.receipts, devices: r.devices, total: n(r.total), share: sum ? (n(r.total) / sum) * 100 : null,
        avg: r.devices ? Math.round((n(r.total) / r.devices) * 100) / 100 : null, last: iso(r.last), _href: r.id ? `/partneri/${r.id}` : null,
      }));
      return {
        columns: [
          { key: 'name', label: 'Dobavljač' },
          { key: 'receipts', label: 'Primki', kind: 'int' },
          { key: 'devices', label: 'Uređaja', kind: 'int' },
          { key: 'total', label: 'Nabavna vrijednost', kind: 'money' },
          { key: 'share', label: 'Udio', kind: 'pct', sum: true },
          { key: 'avg', label: 'Prosj. po uređaju', kind: 'money', sum: false },
          { key: 'last', label: 'Zadnja primka', kind: 'date' },
        ],
        rows: out,
        chart: { kind: 'hbar', title: 'Nabava po dobavljaču', rows: out.slice(0, 10).map((r) => ({ label: String(r.name), value: Number(r.total) })) },
      };
    },
  },
];
