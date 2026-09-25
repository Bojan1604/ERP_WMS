import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { today } from '@/domain/dates';
import { inIds, n, periodSql, typeSql, type ReportDef, type Row } from './types';

/** Otvoreni računi (potraživanja) — bez storniranih i bez isključenih partnera. */
const openSql = (companyId: string) =>
  Prisma.sql`i."companyId" = ${companyId} AND i."status" = 'ISSUED' AND i."openAmount" > 0 AND p."excluded" = false`;

const BUCKETS = [
  { key: 'notDue', label: 'Nije dospjelo' },
  { key: 'd30', label: '0–30 dana' },
  { key: 'd60', label: '31–60 dana' },
  { key: 'd90', label: '61–90 dana' },
  { key: 'd90p', label: 'Više od 90' },
];

export const receivableReports: ReportDef[] = [
  {
    slug: 'starost-potrazivanja',
    title: 'Starost potraživanja',
    area: 'Naplata',
    description: 'Otvoreni iznosi po kupcu, razvrstani po danima kašnjenja nakon dospijeća.',
    filters: ['partner', 'type'],
    run: async (companyId, f) => {
      const now = today();
      const rows = await db.$queryRaw<Array<{ id: string; name: string; cnt: number; notDue: Prisma.Decimal; d30: Prisma.Decimal; d60: Prisma.Decimal; d90: Prisma.Decimal; d90p: Prisma.Decimal; total: Prisma.Decimal; maxLate: number | null }>>`
        WITH o AS (
          SELECT i."partnerId", i."openAmount" AS amt, (${now}::date - COALESCE(i."dueDate", i."date")) AS late
          FROM "Invoice" i JOIN "Partner" p ON p.id = i."partnerId"
          WHERE ${openSql(companyId)} ${inIds('i."partnerId"', f.partnerIds)} ${typeSql('i."type"', f)}
        )
        SELECT p.id, p.name, COUNT(*)::int AS cnt,
               COALESCE(SUM(amt) FILTER (WHERE late <= 0), 0) AS "notDue",
               COALESCE(SUM(amt) FILTER (WHERE late BETWEEN 1 AND 30), 0) AS d30,
               COALESCE(SUM(amt) FILTER (WHERE late BETWEEN 31 AND 60), 0) AS d60,
               COALESCE(SUM(amt) FILTER (WHERE late BETWEEN 61 AND 90), 0) AS d90,
               COALESCE(SUM(amt) FILTER (WHERE late > 90), 0) AS d90p,
               SUM(amt) AS total, MAX(late)::int AS "maxLate"
        FROM o JOIN "Partner" p ON p.id = o."partnerId"
        GROUP BY p.id ORDER BY total DESC`;
      const out: Row[] = rows.map((r) => ({
        name: r.name, invoices: r.cnt, notDue: n(r.notDue), d30: n(r.d30), d60: n(r.d60), d90: n(r.d90), d90p: n(r.d90p), total: n(r.total),
        maxLate: r.maxLate && r.maxLate > 0 ? r.maxLate : null, _href: `/partneri/${r.id}?tab=racuni`,
      }));
      const sums = Object.fromEntries(BUCKETS.map((b) => [b.key, out.reduce((a, r) => a + Number(r[b.key] ?? 0), 0)]));
      return {
        columns: [
          { key: 'name', label: 'Kupac' },
          { key: 'invoices', label: 'Računa', kind: 'int' },
          ...BUCKETS.map((b) => ({ key: b.key, label: b.label, kind: 'money' as const })),
          { key: 'total', label: 'Ukupno otvoreno', kind: 'money' },
          { key: 'maxLate', label: 'Najdulje kašnjenje', kind: 'days', sum: false },
        ],
        rows: out,
        chart: { kind: 'bar', series: [{ key: 'v', label: 'Otvoreno' }], data: BUCKETS.map((b) => ({ label: b.label, values: { v: sums[b.key] } })) },
        note: 'Dani kašnjenja računaju se od datuma dospijeća (bez roka — od datuma računa) do danas.',
      };
    },
  },
  {
    slug: 'nenaplaceni-racuni',
    title: 'Nenaplaćeni računi',
    area: 'Naplata',
    description: 'Svi izdani računi s otvorenim iznosom, od najstarijeg dospijeća.',
    filters: ['range', 'partner', 'type'],
    run: async (companyId, f) => {
      const now = today();
      const rows = await db.$queryRaw<Array<{ id: string; number: string | null; partner: string; date: Date; dueDate: Date | null; total: Prisma.Decimal; paid: Prisma.Decimal; open: Prisma.Decimal; late: number }>>`
        SELECT i.id, i."number", p.name AS partner, i."date", i."dueDate", i."grandTotal" AS total, i."paidTotal" + i."advanceAmount" + i."creditedTotal" AS paid,
               i."openAmount" AS open, (${now}::date - COALESCE(i."dueDate", i."date"))::int AS late
        FROM "Invoice" i JOIN "Partner" p ON p.id = i."partnerId"
        WHERE ${openSql(companyId)} ${inIds('i."partnerId"', f.partnerIds)} ${typeSql('i."type"', f)} ${periodSql('i."date"', { year: null, from: f.from, to: f.to })}
        ORDER BY COALESCE(i."dueDate", i."date"), i."seq"
        LIMIT 2000`;
      return {
        columns: [
          { key: 'number', label: 'Račun' },
          { key: 'partner', label: 'Kupac' },
          { key: 'date', label: 'Datum', kind: 'date' },
          { key: 'dueDate', label: 'Dospijeće', kind: 'date' },
          { key: 'late', label: 'Kasni', kind: 'days', sum: false },
          { key: 'total', label: 'Iznos', kind: 'money' },
          { key: 'paid', label: 'Plaćeno / umanjeno', kind: 'money' },
          { key: 'open', label: 'Otvoreno', kind: 'money' },
        ],
        rows: rows.map((r) => ({
          number: r.number, partner: r.partner, date: r.date.toISOString().slice(0, 10), dueDate: r.dueDate?.toISOString().slice(0, 10) ?? null,
          late: r.late > 0 ? r.late : null, total: n(r.total), paid: n(r.paid), open: n(r.open), _href: `/prodaja/racuni/${r.id}`,
        })),
        note: rows.length === 2000 ? 'Prikazano je prvih 2000 računa.' : undefined,
      };
    },
  },
  {
    slug: 'brzina-naplate',
    title: 'Brzina naplate po kupcu',
    area: 'Naplata',
    description: 'Prosječan broj dana od datuma računa do potpune naplate, i koliko kupac kasni nakon dospijeća.',
    filters: ['year', 'range', 'partner', 'type'],
    run: async (companyId, f) => {
      const rows = await db.$queryRaw<Array<{ id: string; name: string; paid: number; avgDays: number | null; avgLate: number | null; lateShare: number | null; maxDays: number | null; amount: Prisma.Decimal }>>`
        SELECT p.id, p.name, COUNT(*)::int AS paid,
               AVG(i."paidDate" - i."date")::float8 AS "avgDays",
               AVG(GREATEST(0, i."paidDate" - COALESCE(i."dueDate", i."date")))::float8 AS "avgLate",
               (COUNT(*) FILTER (WHERE i."paidDate" > COALESCE(i."dueDate", i."date")) * 100.0 / COUNT(*))::float8 AS "lateShare",
               MAX(i."paidDate" - i."date")::int AS "maxDays",
               SUM(i."grandTotal") AS amount
        FROM "Invoice" i JOIN "Partner" p ON p.id = i."partnerId"
        WHERE i."companyId" = ${companyId} AND i."status" = 'ISSUED' AND i."kind" IN ('INVOICE','ADVANCE') AND i."stornoed" = false
          AND i."paidDate" IS NOT NULL AND p."excluded" = false ${periodSql('i."date"', f)} ${inIds('i."partnerId"', f.partnerIds)} ${typeSql('i."type"', f)}
        GROUP BY p.id ORDER BY "avgDays" DESC`;
      const all = rows.reduce((a, r) => a + r.paid, 0);
      const wAvg = (k: 'avgDays' | 'avgLate') => (all ? rows.reduce((a, r) => a + (r[k] ?? 0) * r.paid, 0) / all : null);
      return {
        columns: [
          { key: 'name', label: 'Kupac' },
          { key: 'paid', label: 'Plaćenih računa', kind: 'int' },
          { key: 'amount', label: 'Iznos', kind: 'money' },
          { key: 'avgDays', label: 'Prosj. dana do naplate', kind: 'days', sum: false },
          { key: 'avgLate', label: 'Prosj. kašnjenje', kind: 'days', sum: false },
          { key: 'lateShare', label: 'Plaćeno sa zakašnjenjem', kind: 'pct', sum: false },
          { key: 'maxDays', label: 'Najdulje', kind: 'days', sum: false },
        ],
        rows: rows.map((r) => ({
          name: r.name, paid: r.paid, amount: n(r.amount), avgDays: r.avgDays === null ? null : Math.round(r.avgDays * 10) / 10,
          avgLate: r.avgLate === null ? null : Math.round(r.avgLate * 10) / 10, lateShare: r.lateShare, maxDays: r.maxDays, _href: `/partneri/${r.id}?tab=racuni`,
        })),
        totals: { paid: all, amount: rows.reduce((a, r) => a + n(r.amount), 0), avgDays: wAvg('avgDays') === null ? null : Math.round(wAvg('avgDays')! * 10) / 10, avgLate: wAvg('avgLate') === null ? null : Math.round(wAvg('avgLate')! * 10) / 10 },
        chart: { kind: 'hbar', title: 'Prosječno dana do naplate', unit: 'int', rows: rows.slice(0, 10).map((r) => ({ label: r.name, value: Math.round(r.avgDays ?? 0) })) },
        note: 'Uzimaju se potpuno plaćeni računi iz odabrane godine; datum naplate je datum zadnje uplate.',
      };
    },
  },
];
