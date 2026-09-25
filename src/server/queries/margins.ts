import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { getCompany } from './lookups';
import { fromISO, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { grossMargin, priceFromMargin, suggestedSalePrice } from '@/domain/pricing';
import { expandExpense, type FrequencyCode } from '@/domain/expenses';
import { paramStr, parseDateRange, parseMulti, type SearchParams } from '@/lib/list-params';

/**
 * Marže i profit (Prodaja → Marže): prodani uređaji s poznatom prodajnom
 * cijenom (Item.salePrice, upisuje je izdavanje računa), skupine po kupcu,
 * modelu i kategoriji, poslovanje (prihodi iz računa, rashodi iz troškova) i
 * preporučene marže po modelu. Sve zbrajanje radi baza.
 */

export const MARGIN_VIEWS = ['poslovanje', 'artikl', 'kupac', 'model', 'kategorija', 'marze', 'paketi'] as const;
export type MarginView = (typeof MARGIN_VIEWS)[number];

export interface MarginFilters {
  view: MarginView;
  year: string;
  from: string | null;
  to: string | null;
  q: string;
  categories: string[];
  models: string[];
  partners: string[];
}

export function readMarginFilters(sp: SearchParams): MarginFilters {
  const v = paramStr(sp, 'pogled') as MarginView;
  const range = parseDateRange(sp);
  return {
    view: MARGIN_VIEWS.includes(v) ? v : 'poslovanje',
    year: paramStr(sp, 'godina') || today().slice(0, 4),
    from: range.from,
    to: range.to,
    q: paramStr(sp, 'q'),
    categories: parseMulti(sp, 'kategorija'),
    models: parseMulti(sp, 'model'),
    partners: parseMulti(sp, 'kupac'),
  };
}

/** Razdoblje filtra: od/do ima prednost pred godinom; 'sve' = bez ograničenja. */
export function marginRange(f: MarginFilters): { from: string; to: string } {
  if (f.from || f.to) return { from: f.from ?? '1900-01-01', to: f.to ?? '2999-12-31' };
  if (/^\d{4}$/.test(f.year)) return { from: `${f.year}-01-01`, to: `${f.year}-12-31` };
  return { from: '1900-01-01', to: '2999-12-31' };
}

/** Uvjet nad prodanim uređajima (alias i = Item, m = DeviceModel, p = Partner). */
function soldWhere(companyId: string, f: MarginFilters): Prisma.Sql {
  const { from, to } = marginRange(f);
  const parts: Prisma.Sql[] = [
    Prisma.sql`i."companyId" = ${companyId}`,
    Prisma.sql`i.state = 'SOLD'`,
    Prisma.sql`(p.id IS NULL OR p.excluded = false)`,
    Prisma.sql`i."issueDate" BETWEEN ${fromISO(from)} AND ${fromISO(to)}`,
  ];
  if (f.categories.length) parts.push(Prisma.sql`COALESCE(i."categoryId", m."categoryId") IN (${Prisma.join(f.categories)})`);
  if (f.models.length) parts.push(Prisma.sql`i."modelId" IN (${Prisma.join(f.models)})`);
  if (f.partners.length) parts.push(Prisma.sql`i."partnerId" IN (${Prisma.join(f.partners)})`);
  if (f.q) {
    const like = `%${f.q}%`;
    parts.push(Prisma.sql`(i.serial ILIKE ${like} OR m.name ILIKE ${like} OR COALESCE(m.brand, '') ILIKE ${like} OR COALESCE(p.name, '') ILIKE ${like})`);
  }
  return Prisma.join(parts, ' AND ');
}

const SOLD_FROM = Prisma.sql`FROM "Item" i JOIN "DeviceModel" m ON m.id = i."modelId" LEFT JOIN "Partner" p ON p.id = i."partnerId"`;

export interface MarginTotals {
  sold: number;
  priced: number;
  unpriced: number;
  cost: number;
  revenue: number;
  profit: number;
  margin: number | null;
  avgCost: number;
  avgPrice: number;
}

/** Zbrojevi prodanih uređaja (marža samo na uređajima s poznatom prodajnom cijenom). */
export async function marginTotals(companyId: string, f: MarginFilters): Promise<MarginTotals> {
  const rows = await db.$queryRaw<Array<{ sold: bigint; priced: bigint; cost: Prisma.Decimal | null; revenue: Prisma.Decimal | null }>>`
    SELECT count(*) AS sold,
           count(*) FILTER (WHERE i."salePrice" > 0) AS priced,
           sum(i.cost) FILTER (WHERE i."salePrice" > 0) AS cost,
           sum(i."salePrice") FILTER (WHERE i."salePrice" > 0) AS revenue
    ${SOLD_FROM} WHERE ${soldWhere(companyId, f)}`;
  const r = rows[0];
  const sold = Number(r?.sold ?? 0);
  const priced = Number(r?.priced ?? 0);
  const cost = r2(num(r?.cost));
  const revenue = r2(num(r?.revenue));
  return {
    sold,
    priced,
    unpriced: sold - priced,
    cost,
    revenue,
    profit: r2(revenue - cost),
    margin: grossMargin(revenue, cost),
    avgCost: priced ? r2(cost / priced) : 0,
    avgPrice: priced ? r2(revenue / priced) : 0,
  };
}

export interface MarginGroup {
  key: string | null;
  label: string;
  n: number;
  cost: number;
  revenue: number;
  profit: number;
  margin: number | null;
  avgPrice: number;
}

/** Skupine po kupcu, modelu ili kategoriji (samo uređaji s prodajnom cijenom), najveći profit prvi. */
export async function marginGroups(companyId: string, f: MarginFilters, by: 'kupac' | 'model' | 'kategorija'): Promise<MarginGroup[]> {
  const key =
    by === 'kupac'
      ? Prisma.sql`i."partnerId"`
      : by === 'model'
        ? Prisma.sql`i."modelId"`
        : Prisma.sql`COALESCE(i."categoryId", m."categoryId")`;
  const rows = await db.$queryRaw<Array<{ key: string | null; n: bigint; cost: Prisma.Decimal | null; revenue: Prisma.Decimal | null }>>`
    SELECT ${key} AS key, count(*) AS n, sum(i.cost) AS cost, sum(i."salePrice") AS revenue
    ${SOLD_FROM} WHERE ${soldWhere(companyId, f)} AND i."salePrice" > 0
    GROUP BY 1`;
  const ids = rows.map((r) => r.key).filter((x): x is string => !!x);
  const names = new Map<string, string>();
  if (ids.length) {
    if (by === 'kupac') (await db.partner.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, name: true } })).forEach((x) => names.set(x.id, x.name));
    else if (by === 'model')
      (await db.deviceModel.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, brand: true, name: true } })).forEach((x) => names.set(x.id, [x.brand, x.name].filter(Boolean).join(' ')));
    else (await db.category.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, name: true } })).forEach((x) => names.set(x.id, x.name));
  }
  return rows
    .map((r) => {
      const cost = r2(num(r.cost));
      const revenue = r2(num(r.revenue));
      const n = Number(r.n);
      return { key: r.key, label: r.key ? (names.get(r.key) ?? '—') : '—', n, cost, revenue, profit: r2(revenue - cost), margin: grossMargin(revenue, cost), avgPrice: n ? r2(revenue / n) : 0 };
    })
    .sort((a, b) => b.profit - a.profit);
}

/** Prodani uređaji (po stranicama, filtar i redoslijed u bazi). */
export async function soldItems(companyId: string, f: MarginFilters, page: { skip: number; take: number }) {
  const company = await getCompany(companyId);
  const { from, to } = marginRange(f);
  const and: Prisma.ItemWhereInput[] = [{ OR: [{ partnerId: null }, { partner: { excluded: false } }] }];
  if (f.categories.length) and.push({ OR: [{ categoryId: { in: f.categories } }, { categoryId: null, model: { categoryId: { in: f.categories } } }] });
  if (f.q) {
    and.push({
      OR: [
        { serial: { contains: f.q, mode: 'insensitive' } },
        { model: { name: { contains: f.q, mode: 'insensitive' } } },
        { partner: { name: { contains: f.q, mode: 'insensitive' } } },
      ],
    });
  }
  const where: Prisma.ItemWhereInput = {
    companyId,
    state: 'SOLD',
    issueDate: { gte: fromISO(from), lte: fromISO(to) },
    ...(f.models.length ? { modelId: { in: f.models } } : {}),
    ...(f.partners.length ? { partnerId: { in: f.partners } } : {}),
    AND: and,
  };
  const [rows, total] = await Promise.all([
    db.item.findMany({
      where,
      orderBy: [{ issueDate: 'desc' }, { serial: 'asc' }],
      skip: page.skip,
      take: page.take,
      select: {
        id: true,
        serial: true,
        cost: true,
        salePrice: true,
        marginPct: true,
        issueDate: true,
        model: { select: { brand: true, name: true, salePrice: true, marginPct: true, category: { select: { name: true } } } },
        category: { select: { name: true } },
        partner: { select: { name: true } },
        invoice: { select: { id: true, number: true } },
      },
    }),
    db.item.count({ where }),
  ]);
  return {
    total,
    rows: rows.map((i) => {
      const cost = num(i.cost);
      const price = i.salePrice === null ? null : num(i.salePrice);
      const suggested = suggestedSalePrice({
        modelPrice: i.model.salePrice === null ? null : num(i.model.salePrice),
        cost,
        itemMargin: i.marginPct === null ? null : num(i.marginPct),
        modelMargin: i.model.marginPct === null ? null : num(i.model.marginPct),
        companyMargin: num(company.defaultMarginPct),
      }).price;
      return {
        id: i.id,
        serial: i.serial,
        model: [i.model.brand, i.model.name].filter(Boolean).join(' '),
        category: i.category?.name ?? i.model.category?.name ?? null,
        partner: i.partner?.name ?? null,
        invoice: i.invoice,
        date: i.issueDate,
        cost,
        price,
        suggested,
        profit: price && price > 0 ? r2(price - cost) : null,
        margin: price && price > 0 ? grossMargin(price, cost) : null,
      };
    }),
  };
}

/**
 * Poslovanje: prihodi iz izdanih računa (osnovica, razložena po vrsti stavke:
 * oprema, najam, usluge), naplata, rashodi iz troškova (ponavljajući se šire u
 * rate), rezultat po mjesecima i kupci. Svi iznosi su bez PDV-a.
 */
export async function business(companyId: string, f: MarginFilters) {
  const { from, to } = marginRange(f);
  const t = today();
  const partnerSql = f.partners.length ? Prisma.sql`AND v."partnerId" IN (${Prisma.join(f.partners)})` : Prisma.empty;
  const invWhere = Prisma.sql`v."companyId" = ${companyId} AND v.status = 'ISSUED' AND p.excluded = false AND v.date BETWEEN ${fromISO(from)} AND ${fromISO(to)} ${partnerSql}`;
  const [split, sums, months, customers] = await Promise.all([
    db.$queryRaw<Array<{ bucket: string; net: Prisma.Decimal | null }>>`
      SELECT CASE
               WHEN l."modelId" IS NULL AND l."itemId" IS NULL THEN 'usluge'
               WHEN COALESCE(l."lineType", v.type) = 'RENT' THEN 'najam'
               WHEN COALESCE(l."lineType", v.type) = 'SERVICE' THEN 'usluge'
               ELSE 'oprema'
             END AS bucket,
             sum(l."netAmount") AS net
      FROM "InvoiceLine" l JOIN "Invoice" v ON v.id = l."invoiceId" JOIN "Partner" p ON p.id = v."partnerId"
      WHERE ${invWhere}
      GROUP BY 1`,
    db.$queryRaw<Array<{ n: bigint; net: Prisma.Decimal | null; paid: Prisma.Decimal | null; late: Prisma.Decimal | null; open: Prisma.Decimal | null }>>`
      SELECT count(*) FILTER (WHERE v.kind IN ('INVOICE', 'ADVANCE')) AS n,
             sum(v."netTotal") AS net,
             sum(CASE WHEN v."grandTotal" <> 0 AND v.kind IN ('INVOICE', 'ADVANCE') THEN v."paidTotal" / v."grandTotal" * v."netTotal" ELSE 0 END) AS paid,
             sum(CASE WHEN v."grandTotal" <> 0 AND v."openAmount" > 0 AND COALESCE(v."dueDate", v.date) < ${fromISO(t)} THEN v."openAmount" / v."grandTotal" * v."netTotal" ELSE 0 END) AS late,
             sum(CASE WHEN v."grandTotal" <> 0 AND v."openAmount" > 0 THEN v."openAmount" / v."grandTotal" * v."netTotal" ELSE 0 END) AS open
      FROM "Invoice" v JOIN "Partner" p ON p.id = v."partnerId"
      WHERE ${invWhere}`,
    db.$queryRaw<Array<{ m: number; net: Prisma.Decimal | null }>>`
      SELECT extract(month FROM v.date)::int AS m, sum(v."netTotal") AS net
      FROM "Invoice" v JOIN "Partner" p ON p.id = v."partnerId"
      WHERE ${invWhere}
      GROUP BY 1`,
    db.$queryRaw<Array<{ id: string; name: string; n: bigint; net: Prisma.Decimal | null; open: Prisma.Decimal | null }>>`
      SELECT p.id, p.name, count(*) FILTER (WHERE v.kind IN ('INVOICE', 'ADVANCE')) AS n, sum(v."netTotal") AS net,
             sum(CASE WHEN v."grandTotal" <> 0 AND v."openAmount" > 0 THEN v."openAmount" / v."grandTotal" * v."netTotal" ELSE 0 END) AS open
      FROM "Invoice" v JOIN "Partner" p ON p.id = v."partnerId"
      WHERE ${invWhere}
      GROUP BY p.id, p.name
      ORDER BY 4 DESC
      LIMIT 100`,
  ]);

  // rashodi: jednokratni u rasponu i ponavljajući koji su počeli prije kraja raspona
  const bookedTo = to < t ? to : t;
  const expenses = await db.expense.findMany({
    where: {
      companyId,
      date: { lte: fromISO(to) },
      OR: [{ frequency: null, date: { gte: fromISO(from) } }, { frequency: { not: null }, OR: [{ recurringUntil: null }, { recurringUntil: { gte: fromISO(from) } }] }],
      AND: [{ OR: [{ partnerId: null }, { partner: { excluded: false } }] }, ...(f.partners.length ? [{ OR: [{ partnerId: null }, { partnerId: { in: f.partners } }] }] : [])],
    },
    select: { id: true, date: true, netAmount: true, vatAmount: true, frequency: true, recurringUntil: true, overrides: true, category: { select: { name: true } } },
  });
  const byCat = new Map<string, { amount: number; n: number }>();
  const expMonth = new Array(12).fill(0) as number[];
  let expense = 0;
  let expenseN = 0;
  for (const e of expenses) {
    const occ = expandExpense(
      {
        id: e.id,
        date: e.date.toISOString().slice(0, 10),
        netAmount: num(e.netAmount),
        vatAmount: num(e.vatAmount),
        frequency: e.frequency as FrequencyCode | null,
        recurringUntil: e.recurringUntil ? e.recurringUntil.toISOString().slice(0, 10) : null,
        overrides: (e.overrides ?? {}) as Record<string, { amount?: number; skipped?: boolean }>,
      },
      from,
      to,
      bookedTo,
    );
    for (const o of occ) {
      const k = e.category?.name ?? 'Bez kategorije';
      const cur = byCat.get(k) ?? { amount: 0, n: 0 };
      cur.amount += o.netAmount;
      cur.n += 1;
      byCat.set(k, cur);
      expMonth[Number(o.period.slice(5, 7)) - 1] += o.netAmount;
      expense += o.netAmount;
      expenseN += 1;
    }
  }

  const s = sums[0];
  const revenue = r2(num(s?.net));
  // razdioba po vrsti stavke svedena na osnovicu računa (popust na cijeli račun)
  const linesSum = split.reduce((a, x) => a + num(x.net), 0);
  const scale = linesSum ? revenue / linesSum : 0;
  const bucket = (k: string) => r2(num(split.find((x) => x.bucket === k)?.net) * scale);
  const incomeMonth = new Array(12).fill(0) as number[];
  for (const m of months) incomeMonth[m.m - 1] = r2(num(m.net));

  // nabavna vrijednost prodane opreme u razdoblju (bruto marža na opremi)
  const eq = await marginTotals(companyId, { ...f, q: '' });
  return {
    invoices: Number(s?.n ?? 0),
    revenue,
    byType: { oprema: bucket('oprema'), najam: bucket('najam'), usluge: bucket('usluge') },
    paid: r2(num(s?.paid)),
    open: r2(num(s?.open)),
    late: r2(num(s?.late)),
    expense: r2(expense),
    expenseN,
    expenseByCategory: [...byCat.entries()].map(([name, v]) => ({ name, amount: r2(v.amount), n: v.n })).sort((a, b) => b.amount - a.amount),
    months: incomeMonth.map((inc, i) => ({ month: i + 1, income: inc, expense: r2(expMonth[i]), result: r2(inc - expMonth[i]) })),
    customers: customers.map((c) => ({ id: c.id, name: c.name, n: Number(c.n), net: r2(num(c.net)), open: r2(num(c.open)) })),
    equipment: { revenue: eq.revenue, cost: eq.cost, margin: eq.margin },
  };
}

/** Preporučena marža po modelu: uređaja, na skladištu, prosječna nabavna, marža (vlastita ili globalna) i cijena. */
export async function modelMargins(companyId: string) {
  const company = await getCompany(companyId);
  const [models, stats] = await Promise.all([
    db.deviceModel.findMany({
      where: { companyId, active: true },
      orderBy: [{ brand: 'asc' }, { name: 'asc' }],
      select: { id: true, brand: true, name: true, marginPct: true, salePrice: true, category: { select: { name: true } } },
    }),
    db.$queryRaw<Array<{ modelId: string; n: bigint; stock: bigint; avg: Prisma.Decimal | null }>>`
      SELECT "modelId", count(*) AS n, count(*) FILTER (WHERE state IN ('IN_STOCK', 'RESERVED')) AS stock, avg(cost) AS avg
      FROM "Item" WHERE "companyId" = ${companyId} GROUP BY "modelId"`,
  ]);
  const byModel = new Map(stats.map((s) => [s.modelId, s]));
  const global = num(company.defaultMarginPct);
  return {
    global,
    rows: models.map((m) => {
      const st = byModel.get(m.id);
      const avgCost = r2(num(st?.avg));
      const own = m.marginPct === null ? null : num(m.marginPct);
      return {
        id: m.id,
        name: [m.brand, m.name].filter(Boolean).join(' '),
        category: m.category?.name ?? null,
        devices: Number(st?.n ?? 0),
        stock: Number(st?.stock ?? 0),
        avgCost,
        marginPct: own,
        salePrice: m.salePrice === null ? null : num(m.salePrice),
        price: priceFromMargin(avgCost, own ?? global),
      };
    }),
  };
}

/** Godine s prodanim uređajima (za odabir godine). */
export async function marginYears(companyId: string) {
  const rows = await db.$queryRaw<Array<{ y: number }>>`
    SELECT DISTINCT extract(year FROM "issueDate")::int AS y FROM "Item" WHERE "companyId" = ${companyId} AND state = 'SOLD' AND "issueDate" IS NOT NULL ORDER BY 1 DESC LIMIT 10`;
  const years = rows.map((r) => r.y);
  const cur = Number(today().slice(0, 4));
  if (!years.includes(cur)) years.unshift(cur);
  return years;
}
