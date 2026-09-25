import 'server-only';
import { Prisma } from '@prisma/client';
import { reportSql } from './sql';
import { addDays, today } from '@/domain/dates';
import { STATUS_KIND_LABEL } from '../../services/items';
import { inIds, iso, itemFilterSql, n, periodSql, r2, type ReportDef, type Row } from './types';
/** Uređaji isključenih partnera ne ulaze u izvještaje. */
const notExcluded = Prisma.sql`(hp.id IS NULL OR hp."excluded" = false)`;

const AGE = [
  { key: 'a3', label: 'do 3 mj.', from: 0, to: 3 },
  { key: 'a6', label: '3–6 mj.', from: 3, to: 6 },
  { key: 'a12', label: '6–12 mj.', from: 6, to: 12 },
  { key: 'a24', label: '12–24 mj.', from: 12, to: 24 },
  { key: 'a24p', label: 'više od 24', from: 24, to: 100000 },
];

export const stockReports: ReportDef[] = [
  {
    slug: 'stanje-po-statusima',
    title: 'Stanje zalihe po statusima',
    area: 'Skladište',
    description: 'Broj uređaja i nabavna vrijednost po statusu.',
    filters: ['partner', 'category', 'model', 'status', 'warehouse', 'supplier'],
    run: async (companyId, f) => {
      const rows = await reportSql<Array<{ name: string; kind: string; cnt: number; value: Prisma.Decimal }>>`
        SELECT s.name, s."kind"::text AS kind, COUNT(it.id)::int AS cnt, COALESCE(SUM(it."cost"), 0) AS value
        FROM "Item" it
        JOIN "ItemStatus" s ON s.id = it."statusId"
        JOIN "DeviceModel" m ON m.id = it."modelId"
        LEFT JOIN "Partner" hp ON hp.id = it."partnerId"
        WHERE it."companyId" = ${companyId} AND ${notExcluded} ${itemFilterSql(f)}
        GROUP BY s.id ORDER BY s."sort", s.name`;
      const total = rows.reduce((a, r) => a + r.cnt, 0);
      const out: Row[] = rows.map((r) => ({
        name: r.name, kind: STATUS_KIND_LABEL[r.kind as keyof typeof STATUS_KIND_LABEL], count: r.cnt, share: total ? (r.cnt / total) * 100 : null,
        value: n(r.value), avg: r.cnt ? r2(n(r.value) / r.cnt) : null,
      }));
      return {
        columns: [
          { key: 'name', label: 'Status' },
          { key: 'kind', label: 'Vrsta' },
          { key: 'count', label: 'Uređaja', kind: 'int' },
          { key: 'share', label: 'Udio', kind: 'pct', sum: true },
          { key: 'value', label: 'Nabavna vrijednost', kind: 'money', cost: true },
          { key: 'avg', label: 'Prosj. nabavna', kind: 'money', sum: false, cost: true },
        ],
        rows: out,
        chart: { kind: 'hbar', title: 'Uređaja po statusu', unit: 'int', rows: out.map((r) => ({ label: String(r.name), value: Number(r.count) })) },
      };
    },
  },
  {
    slug: 'zaliha-po-kategoriji',
    title: 'Zaliha po kategoriji i skladištu',
    area: 'Skladište',
    description: 'Uređaji na skladištu (raspoloživi) po kategoriji i skladištu, s nabavnom vrijednošću.',
    filters: ['category', 'model', 'status', 'warehouse', 'supplier'],
    run: async (companyId, f) => {
      const rows = await reportSql<Array<{ category: string | null; warehouse: string | null; cnt: number; value: Prisma.Decimal; models: number }>>`
        SELECT c.name AS category, w.name AS warehouse, COUNT(*)::int AS cnt, SUM(it."cost") AS value, COUNT(DISTINCT m.id)::int AS models
        FROM "Item" it
        JOIN "DeviceModel" m ON m.id = it."modelId"
        LEFT JOIN "Category" c ON c.id = COALESCE(it."categoryId", m."categoryId")
        LEFT JOIN "Warehouse" w ON w.id = it."warehouseId"
        WHERE it."companyId" = ${companyId} AND it."state" = 'IN_STOCK' ${itemFilterSql(f, { partner: false })}
        GROUP BY c.name, w.name ORDER BY c.name NULLS LAST, w.name NULLS LAST`;
      const byCat = new Map<string, number>();
      for (const r of rows) byCat.set(r.category ?? 'Bez kategorije', (byCat.get(r.category ?? 'Bez kategorije') ?? 0) + n(r.value));
      return {
        columns: [
          { key: 'category', label: 'Kategorija' },
          { key: 'warehouse', label: 'Skladište' },
          { key: 'models', label: 'Modela', kind: 'int', sum: false },
          { key: 'count', label: 'Uređaja', kind: 'int' },
          { key: 'value', label: 'Nabavna vrijednost', kind: 'money', cost: true },
        ],
        rows: rows.map((r) => ({ category: r.category ?? 'Bez kategorije', warehouse: r.warehouse ?? 'Bez skladišta', models: r.models, count: r.cnt, value: n(r.value) })),
        chart: { kind: 'hbar', title: 'Vrijednost zalihe po kategoriji', rows: [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })) },
        chartCost: true,
      };
    },
  },
  {
    slug: 'starost-zalihe',
    title: 'Starost zalihe',
    area: 'Skladište',
    description: 'Uređaji na skladištu po modelu i broju mjeseci od zaprimanja — gdje stoji roba koja se ne prodaje.',
    filters: ['category', 'model', 'status', 'warehouse', 'supplier'],
    run: async (companyId, f) => {
      const now = today();
      const rows = await reportSql<Array<Record<string, number> & { id: string; model: string; value: Prisma.Decimal; avgDays: number }>>`
        WITH s AS (
          SELECT it."modelId", it."cost",
                 (${now}::date - COALESCE(it."importDate", it."createdAt"::date)) AS days,
                 (EXTRACT(YEAR FROM age(${now}::date, COALESCE(it."importDate", it."createdAt"::date))) * 12
                  + EXTRACT(MONTH FROM age(${now}::date, COALESCE(it."importDate", it."createdAt"::date))))::int AS months
          FROM "Item" it JOIN "DeviceModel" m ON m.id = it."modelId"
          WHERE it."companyId" = ${companyId} AND it."state" = 'IN_STOCK' ${itemFilterSql(f, { partner: false })}
        )
        SELECT m.id, concat_ws(' ', m.brand, m.name) AS model,
               COUNT(*) FILTER (WHERE months < 3)::int AS a3,
               COUNT(*) FILTER (WHERE months >= 3 AND months < 6)::int AS a6,
               COUNT(*) FILTER (WHERE months >= 6 AND months < 12)::int AS a12,
               COUNT(*) FILTER (WHERE months >= 12 AND months < 24)::int AS a24,
               COUNT(*) FILTER (WHERE months >= 24)::int AS a24p,
               COUNT(*)::int AS total, SUM(s."cost") AS value, AVG(days)::float8 AS "avgDays"
        FROM s JOIN "DeviceModel" m ON m.id = s."modelId"
        GROUP BY m.id ORDER BY "avgDays" DESC`;
      const out: Row[] = rows.map((r) => ({
        model: r.model, ...Object.fromEntries(AGE.map((a) => [a.key, r[a.key] || null])), total: r.total, value: n(r.value), avgDays: Math.round(r.avgDays),
      }));
      const sums = Object.fromEntries(AGE.map((a) => [a.key, rows.reduce((x, r) => x + (r[a.key] ?? 0), 0)]));
      return {
        columns: [
          { key: 'model', label: 'Model' },
          ...AGE.map((a) => ({ key: a.key, label: a.label, kind: 'int' as const })),
          { key: 'total', label: 'Ukupno', kind: 'int' },
          { key: 'value', label: 'Nabavna vrijednost', kind: 'money', cost: true },
          { key: 'avgDays', label: 'Prosj. starost', kind: 'days', sum: false },
        ],
        rows: out,
        chart: { kind: 'bar', unit: 'int', series: [{ key: 'v', label: 'Uređaja' }], data: AGE.map((a) => ({ label: a.label, values: { v: sums[a.key] } })) },
        note: 'Starost se računa od datuma zaprimanja (ako ga nema — od unosa uređaja).',
      };
    },
  },
  {
    slug: 'garancije-istjecu',
    title: 'Garancije koje istječu',
    area: 'Skladište',
    description: 'Prodani uređaji kojima jamstvo istječe u odabranom razdoblju — prilika za produženo jamstvo ili zamjenu.',
    filters: ['days', 'partner', 'category', 'model', 'warehouse', 'supplier'],
    defaultDays: 60,
    run: async (companyId, f) => {
      const now = today();
      const rows = await reportSql<Array<{ id: string; serial: string; model: string; partner: string | null; partnerId: string | null; start: Date; ends: Date; left: number }>>`
        SELECT it.id, it.serial, concat_ws(' ', m.brand, m.name) AS model, hp.name AS partner, hp.id AS "partnerId",
               it."warrantyStart" AS start, (it."warrantyStart" + make_interval(months => it."warrantyMonths"))::date AS ends,
               ((it."warrantyStart" + make_interval(months => it."warrantyMonths"))::date - ${now}::date) AS left
        FROM "Item" it
        JOIN "DeviceModel" m ON m.id = it."modelId"
        LEFT JOIN "Partner" hp ON hp.id = it."partnerId"
        WHERE it."companyId" = ${companyId} AND it."state" = 'SOLD' AND it."warrantyStart" IS NOT NULL AND it."warrantyMonths" > 0 AND ${notExcluded}
          AND (it."warrantyStart" + make_interval(months => it."warrantyMonths"))::date BETWEEN ${now}::date AND ${addDays(now, f.days)}::date
          ${itemFilterSql(f)}
        ORDER BY ends, it.serial
        LIMIT 2000`;
      return {
        columns: [
          { key: 'serial', label: 'Serijski broj', kind: 'mono' },
          { key: 'model', label: 'Model' },
          { key: 'partner', label: 'Kupac' },
          { key: 'start', label: 'Prodano', kind: 'date' },
          { key: 'ends', label: 'Jamstvo do', kind: 'date' },
          { key: 'left', label: 'Preostalo', kind: 'days', sum: false },
        ],
        rows: rows.map((r) => ({ serial: r.serial, model: r.model, partner: r.partner, start: iso(r.start), ends: iso(r.ends), left: r.left, _href: `/skladiste/${r.id}` })),
        totals: { serial: `${rows.length} uređaja` },
      };
    },
  },
  {
    slug: 'otpisani-uredaji',
    title: 'Otpisani uređaji',
    area: 'Skladište',
    description: 'Uređaji otpisani u godini, s razlogom i nabavnom vrijednošću (gubitak).',
    filters: ['year', 'range', 'category', 'model', 'warehouse', 'supplier'],
    run: async (companyId, f, ctx) => {
      // može biti desetke tisuća uređaja: ekran dobiva stranicu iz baze, zbroj ide agregatom; izvoz sve
      const where = Prisma.sql`it."companyId" = ${companyId} AND it."state" = 'WRITTEN_OFF'
          ${periodSql('COALESCE(it."writeOffDate", it."updatedAt"::date)', f)} ${itemFilterSql(f, { partner: false })}`;
      const page = ctx.page ? Prisma.sql`LIMIT ${ctx.page.take} OFFSET ${ctx.page.skip}` : Prisma.empty;
      const [rows, [agg]] = await Promise.all([
        reportSql<Array<{ id: string; serial: string; model: string; date: Date | null; reason: string | null; cost: Prisma.Decimal }>>`
          SELECT it.id, it.serial, concat_ws(' ', m.brand, m.name) AS model, it."writeOffDate" AS date, it."writeOffReason" AS reason, it."cost"
          FROM "Item" it JOIN "DeviceModel" m ON m.id = it."modelId"
          WHERE ${where}
          ORDER BY it."writeOffDate" DESC NULLS LAST, it.serial, it.id ${page}`,
        reportSql<Array<{ cnt: number; cost: Prisma.Decimal | null }>>`
          SELECT COUNT(*)::int AS cnt, SUM(it."cost") AS cost FROM "Item" it JOIN "DeviceModel" m ON m.id = it."modelId" WHERE ${where}`,
      ]);
      return {
        columns: [
          { key: 'serial', label: 'Serijski broj', kind: 'mono' },
          { key: 'model', label: 'Model' },
          { key: 'date', label: 'Datum otpisa', kind: 'date' },
          { key: 'reason', label: 'Razlog' },
          { key: 'cost', label: 'Nabavna vrijednost', kind: 'money', cost: true },
        ],
        rows: rows.map((r) => ({ serial: r.serial, model: r.model, date: iso(r.date), reason: r.reason, cost: n(r.cost), _href: `/skladiste/${r.id}` })),
        totals: agg.cnt ? { serial: `${agg.cnt} uređaja`, cost: r2(n(agg.cost)) } : null,
        rowCount: ctx.page ? agg.cnt : undefined,
      };
    },
  },
  {
    slug: 'servis-po-modelu',
    title: 'Servis po modelu',
    area: 'Servis',
    description: 'Servisni nalozi po modelu: otvoreni i zatvoreni, jamstveni, trajanje popravka i udio kvarova.',
    filters: ['year', 'range', 'partner', 'category', 'model'],
    run: async (companyId, f) => {
      const rows = await reportSql<Array<{ model: string | null; total: number; open: number; closed: number; warranty: number; avgDays: number | null; cost: Prisma.Decimal; devices: number | null }>>`
        SELECT concat_ws(' ', m.brand, m.name) AS model, COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE so."status" IN ('REPORTED','RECEIVED','DIAGNOSIS','AT_SUPPLIER'))::int AS open,
               COUNT(*) FILTER (WHERE so."status" NOT IN ('REPORTED','RECEIVED','DIAGNOSIS','AT_SUPPLIER'))::int AS closed,
               COUNT(*) FILTER (WHERE so."underWarranty")::int AS warranty,
               AVG(so."closedAt" - so."reportedAt")::float8 AS "avgDays",
               SUM(so."cost") AS cost,
               (SELECT COUNT(*)::int FROM "Item" x WHERE x."modelId" = m.id) AS devices
        FROM "ServiceOrder" so
        LEFT JOIN "Item" it ON it.id = so."itemId"
        LEFT JOIN "DeviceModel" m ON m.id = it."modelId"
        LEFT JOIN "Partner" hp ON hp.id = so."partnerId"
        WHERE so."companyId" = ${companyId} ${periodSql('so."reportedAt"', f)} AND ${notExcluded}
          ${inIds('so."partnerId"', f.partnerIds)} ${f.categoryIds.length || f.modelIds.length ? Prisma.sql`AND it.id IS NOT NULL ${itemFilterSql({ ...f, partnerIds: [] }, { partner: false })}` : Prisma.empty}
        GROUP BY m.id ORDER BY total DESC`;
      return {
        columns: [
          { key: 'model', label: 'Model' },
          { key: 'total', label: 'Naloga', kind: 'int' },
          { key: 'open', label: 'Otvoreno', kind: 'int' },
          { key: 'closed', label: 'Zatvoreno', kind: 'int' },
          { key: 'warranty', label: 'U jamstvu', kind: 'int' },
          { key: 'avgDays', label: 'Prosj. trajanje', kind: 'days', sum: false },
          { key: 'rate', label: 'Udio kvarova', kind: 'pct', sum: false },
          { key: 'cost', label: 'Trošak', kind: 'money' },
        ],
        rows: rows.map((r) => ({
          model: r.model || 'Nepoznat uređaj', total: r.total, open: r.open, closed: r.closed, warranty: r.warranty,
          avgDays: r.avgDays === null ? null : Math.round(r.avgDays * 10) / 10, rate: r.devices ? Math.round((r.total / r.devices) * 1000) / 10 : null, cost: n(r.cost),
        })),
        chart: { kind: 'hbar', title: 'Servisnih naloga po modelu', unit: 'int', rows: rows.slice(0, 10).map((r) => ({ label: r.model || 'Nepoznat uređaj', value: r.total })) },
      };
    },
  },
];
