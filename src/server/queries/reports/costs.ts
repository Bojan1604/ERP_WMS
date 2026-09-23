import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { expandExpense, type FrequencyCode } from '@/domain/expenses';
import { toISO } from '@/domain/dates';
import { n, monthChart, monthRows, opt, revenueSql, type ReportDef, type Row } from './types';

/**
 * Troškovi po mjesecima i kategorijama (neto, bez PDV-a). Jednokratni se
 * zbrajaju u bazi; ponavljajući se šire u rate domenskom funkcijom
 * `expandExpense` (knjiže se samo do danas). Troškovi isključenih partnera
 * ne ulaze.
 */
export async function expensesByMonth(companyId: string, year: number, opts: { excludePurchases?: boolean; categoryId?: string | null } = {}) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const noPurchase = opt(!!opts.excludePurchases, Prisma.sql`AND e."source" <> 'RECEIPT'`);
  const cat = opt(!!opts.categoryId, Prisma.sql`AND e."categoryId" = ${opts.categoryId}`);
  const [single, recurring] = await Promise.all([
    db.$queryRaw<Array<{ m: number; categoryId: string | null; net: Prisma.Decimal }>>`
      SELECT EXTRACT(MONTH FROM e."date")::int AS m, e."categoryId", SUM(e."netAmount") AS net
      FROM "Expense" e LEFT JOIN "Partner" p ON p.id = e."partnerId"
      WHERE e."companyId" = ${companyId} AND e."frequency" IS NULL
        AND e."date" BETWEEN ${from}::date AND ${to}::date
        AND (p.id IS NULL OR p."excluded" = false) ${noPurchase} ${cat}
      GROUP BY 1, 2`,
    db.expense.findMany({
      where: {
        companyId,
        frequency: { not: null },
        date: { lte: new Date(`${to}T00:00:00Z`) },
        OR: [{ recurringUntil: null }, { recurringUntil: { gte: new Date(`${from}T00:00:00Z`) } }],
        AND: [{ OR: [{ partnerId: null }, { partner: { excluded: false } }] }],
        ...(opts.excludePurchases ? { source: { not: 'RECEIPT' as const } } : {}),
        ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
      },
      select: { id: true, date: true, categoryId: true, netAmount: true, vatAmount: true, frequency: true, recurringUntil: true, overrides: true },
    }),
  ]);
  const byCategory = new Map<string | null, number[]>();
  const add = (cat: string | null, m: number, v: number) => {
    const arr = byCategory.get(cat) ?? Array<number>(12).fill(0);
    arr[m - 1] += v;
    byCategory.set(cat, arr);
  };
  for (const r of single) add(r.categoryId, r.m, n(r.net));
  for (const e of recurring) {
    const occ = expandExpense(
      {
        id: e.id,
        date: toISO(e.date),
        netAmount: n(e.netAmount),
        vatAmount: n(e.vatAmount),
        frequency: e.frequency as FrequencyCode,
        recurringUntil: e.recurringUntil ? toISO(e.recurringUntil) : null,
        overrides: e.overrides as Record<string, { amount?: number; skipped?: boolean }>,
      },
      from,
      to,
    );
    for (const o of occ) add(e.categoryId, Number(o.period.slice(5, 7)), o.netAmount);
  }
  const total = Array<number>(12).fill(0);
  for (const arr of byCategory.values()) arr.forEach((v, i) => (total[i] += v));
  return { byCategory, total };
}

/** Neto prihod po mjesecima (računi, storna, odobrenja) i nabavna vrijednost prodanog. */
export async function revenueByMonth(companyId: string, year: number) {
  const rows = await db.$queryRaw<Array<{ m: number; net: Prisma.Decimal; cost: Prisma.Decimal }>>`
    SELECT EXTRACT(MONTH FROM i."date")::int AS m, SUM(i."netTotal") AS net,
           SUM(CASE WHEN i."type" = 'SALE' THEN i."costTotal" ELSE 0 END) AS cost
    FROM "Invoice" i JOIN "Partner" p ON p.id = i."partnerId"
    WHERE ${revenueSql(companyId)} AND i."year" = ${year}
    GROUP BY 1`;
  const revenue = Array<number>(12).fill(0);
  const cost = Array<number>(12).fill(0);
  for (const r of rows) {
    revenue[r.m - 1] = n(r.net);
    cost[r.m - 1] = n(r.cost);
  }
  return { revenue, cost };
}

export const costReports: ReportDef[] = [
  {
    slug: 'troskovi-po-mjesecima',
    title: 'Troškovi po mjesecima i kategorijama',
    area: 'Troškovi',
    description: 'Neto troškovi po kategoriji i mjesecu; ponavljajući troškovi knjiže se do tekućeg mjeseca.',
    filters: ['year'],
    run: async (companyId, f) => {
      const [{ byCategory, total }, cats] = await Promise.all([
        expensesByMonth(companyId, f.year),
        db.expenseCategory.findMany({ where: { companyId }, select: { id: true, name: true } }),
      ]);
      const name = new Map(cats.map((c) => [c.id as string | null, c.name]));
      const rows: Row[] = [...byCategory.entries()]
        .map(([id, arr]) => ({
          category: name.get(id) ?? 'Bez kategorije',
          ...Object.fromEntries(arr.map((v, i) => [`m${i + 1}`, v ? Math.round(v * 100) / 100 : null])),
          total: Math.round(arr.reduce((a, b) => a + b, 0) * 100) / 100,
        }))
        .sort((a, b) => Number(b.total) - Number(a.total));
      // graf: četiri najveće kategorije i „ostalo"
      const top = rows.slice(0, 4);
      const series = [...top.map((r, i) => ({ key: `c${i}`, label: String(r.category) })), ...(rows.length > 4 ? [{ key: 'other', label: 'Ostalo' }] : [])];
      const chartRows = monthRows(f.year, (m) => {
        const o: Record<string, number> = {};
        top.forEach((r, i) => (o[`c${i}`] = Number(r[`m${m}`] ?? 0)));
        if (rows.length > 4) o.other = rows.slice(4).reduce((a, r) => a + Number(r[`m${m}`] ?? 0), 0);
        return o;
      });
      return {
        columns: [
          { key: 'category', label: 'Kategorija' },
          ...Array.from({ length: 12 }, (_, i) => ({ key: `m${i + 1}`, label: `${i + 1}.`, kind: 'money' as const })),
          { key: 'total', label: 'Ukupno', kind: 'money' },
        ],
        rows,
        totals: { category: 'Ukupno', ...Object.fromEntries(total.map((v, i) => [`m${i + 1}`, v ? Math.round(v * 100) / 100 : null])), total: Math.round(total.reduce((a, b) => a + b, 0) * 100) / 100 },
        chart: monthChart(f.year, chartRows, series, { stacked: true }),
      };
    },
  },
  {
    slug: 'neto-rezultat',
    title: 'Neto rezultat',
    area: 'Troškovi',
    description: 'Neto prihod umanjen za sve troškove (uključujući nabavu robe) po mjesecima, s kumulativom.',
    filters: ['year'],
    run: async (companyId, f) => {
      const [rev, exp] = await Promise.all([revenueByMonth(companyId, f.year), expensesByMonth(companyId, f.year)]);
      let cum = 0;
      const rows = monthRows(f.year, (m) => {
        const r = rev.revenue[m - 1];
        const e = exp.total[m - 1];
        cum += r - e;
        return { revenue: r, expenses: Math.round(e * 100) / 100, result: Math.round((r - e) * 100) / 100, cumulative: Math.round(cum * 100) / 100 };
      });
      return {
        columns: [
          { key: 'month', label: 'Mjesec' },
          { key: 'revenue', label: 'Prihod', kind: 'money' },
          { key: 'expenses', label: 'Troškovi', kind: 'money' },
          { key: 'result', label: 'Rezultat', kind: 'money' },
          { key: 'cumulative', label: 'Kumulativno', kind: 'money', sum: false },
        ],
        rows,
        chart: monthChart(f.year, rows, [{ key: 'revenue', label: 'Prihod' }, { key: 'expenses', label: 'Troškovi' }], { stacked: false }),
        note: 'Iznosi su bez PDV-a. Nabava robe knjižena kao trošak ulazi u rezultat u mjesecu nabave.',
      };
    },
  },
];
