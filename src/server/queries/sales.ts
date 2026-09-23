import 'server-only';
import type { InvoiceKind, InvoiceType, Prisma, QuoteStatus } from '@prisma/client';
import { db } from '../db';
import { getCompany, getLookups, modelLabel } from './lookups';
import { addDays, fromISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { grossMargin, suggestedSalePrice } from '@/domain/pricing';

type Params = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v.trim() : '');
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

// ================================================================ računi — filtri

export interface InvoiceFilters {
  q: string;
  year: string; // 'sve' ili godina
  partner: string;
  type: string;
  kind: string;
  pay: string;
  from: string;
  to: string;
  excluded: boolean;
  sort: string;
}

export function readInvoiceFilters(sp: Params): InvoiceFilters {
  return {
    q: str(sp.q),
    year: str(sp.godina) || today().slice(0, 4),
    partner: str(sp.partner),
    type: str(sp.vrsta),
    kind: str(sp.dokument),
    pay: str(sp.naplata),
    from: str(sp.od),
    to: str(sp.do),
    excluded: str(sp.iskljuceni) === '1',
    sort: str(sp.sort),
  };
}

/** Potraživanje s otvorenim iznosom (račun ili predujam, nije storniran). */
const OPEN: Prisma.InvoiceWhereInput = { status: 'ISSUED', kind: { in: ['INVOICE', 'ADVANCE'] }, stornoed: false, openAmount: { gt: 0.005 } };
/** Izdano, bez otvorenog potraživanja (plaćeno, storno, odobrenje, stornirano). */
const CLOSED: Prisma.InvoiceWhereInput = {
  status: 'ISSUED',
  OR: [{ kind: { in: ['STORNO', 'CREDIT_NOTE'] } }, { stornoed: true }, { openAmount: { lte: 0.005 } }],
};

/**
 * Kašnjenje kao u `paymentState`: prošao rok plaćanja, a bez roka — prag dana
 * iz postavki. Uvjeti su napisani izričito (bez NOT) zbog NULL-a u dueDate.
 */
function lateWhere(overdueDays: number, now = today()): { late: Prisma.InvoiceWhereInput; notLate: Prisma.InvoiceWhereInput } {
  const t = fromISO(now);
  const thr = fromISO(addDays(now, -overdueDays));
  return {
    late: { OR: [{ dueDate: { not: null, lt: t }, date: { lt: t } }, { dueDate: null, date: { lt: thr } }] },
    notLate: { OR: [{ dueDate: { not: null, gte: t } }, { dueDate: { not: null }, date: { gte: t } }, { dueDate: null, date: { gte: thr } }] },
  };
}

export function invoiceWhere(companyId: string, f: InvoiceFilters, overdueDays: number): Prisma.InvoiceWhereInput {
  const and: Prisma.InvoiceWhereInput[] = [{ companyId }];
  if (!f.excluded) and.push({ partner: { excluded: false } });
  if (f.year !== 'sve' && /^\d{4}$/.test(f.year)) and.push({ year: Number(f.year) });
  if (f.partner) and.push({ partnerId: f.partner });
  if (['SALE', 'RENT', 'SERVICE'].includes(f.type)) and.push({ type: f.type as InvoiceType });
  if (['INVOICE', 'ADVANCE', 'STORNO', 'CREDIT_NOTE'].includes(f.kind)) and.push({ kind: f.kind as InvoiceKind });
  if (f.kind === 'STORNOED') and.push({ stornoed: true });
  if (isDate(f.from)) and.push({ date: { gte: fromISO(f.from) } });
  if (isDate(f.to)) and.push({ date: { lte: fromISO(f.to) } });
  if (f.q) {
    and.push({
      OR: [
        { number: { contains: f.q, mode: 'insensitive' } },
        { partner: { name: { contains: f.q, mode: 'insensitive' } } },
        { description: { contains: f.q, mode: 'insensitive' } },
      ],
    });
  }
  const { late, notLate } = lateWhere(overdueDays);
  switch (f.pay) {
    case 'draft':
      and.push({ status: 'DRAFT' });
      break;
    case 'open':
      and.push(OPEN);
      break;
    case 'overdue':
      and.push(OPEN, late);
      break;
    case 'notdue':
      and.push(OPEN, notLate, { paidTotal: { lte: 0 } });
      break;
    case 'partial':
      and.push(OPEN, { paidTotal: { gt: 0 } });
      break;
    case 'paid':
      and.push({ status: 'ISSUED', kind: { in: ['INVOICE', 'ADVANCE'] }, stornoed: false, openAmount: { lte: 0.005 }, grandTotal: { gt: 0 } });
      break;
  }
  return { AND: and };
}

const SORTS: Record<string, Prisma.InvoiceOrderByWithRelationInput[]> = {
  broj: [{ year: 'asc' }, { seq: 'asc' }],
  datum: [{ date: 'asc' }, { seq: 'asc' }],
  dospijece: [{ dueDate: 'asc' }],
  partner: [{ partner: { name: 'asc' } }],
  ukupno: [{ grandTotal: 'asc' }],
  otvoreno: [{ openAmount: 'asc' }],
};

/** ?sort=datum ili ?sort=-datum; null = zadani redoslijed. */
export function invoiceOrder(sort: string): Prisma.InvoiceOrderByWithRelationInput[] | null {
  const desc = sort.startsWith('-');
  const base = SORTS[desc ? sort.slice(1) : sort];
  if (!base) return null;
  const flip = (o: Prisma.InvoiceOrderByWithRelationInput): Prisma.InvoiceOrderByWithRelationInput =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? (desc ? 'desc' : 'asc') : flip(v as Prisma.InvoiceOrderByWithRelationInput)]));
  return [...base.map(flip), { createdAt: 'desc' }];
}

export const invoiceListSelect = {
  id: true,
  status: true,
  kind: true,
  type: true,
  number: true,
  date: true,
  dueDate: true,
  description: true,
  netTotal: true,
  grandTotal: true,
  paidTotal: true,
  openAmount: true,
  paidDate: true,
  stornoed: true,
  refInvoiceId: true,
  partner: { select: { id: true, name: true, excluded: true } },
  _count: { select: { lines: { where: { kind: 'DEVICE' } } } },
} satisfies Prisma.InvoiceSelect;

export type InvoiceListRow = Prisma.InvoiceGetPayload<{ select: typeof invoiceListSelect }>;

/**
 * Popis računa. Zadani redoslijed (kasni → nedospjelo → nacrti → ostalo) radi se
 * u bazi kao četiri skupine: prebroje se, a stranica se sastavi dohvatom samo
 * potrebnih redaka iz skupina koje ona pokriva.
 */
export async function listInvoices(companyId: string, f: InvoiceFilters, page: { skip: number; take: number }) {
  const company = await getCompany(companyId);
  const where = invoiceWhere(companyId, f, company.overdueDays);
  const { late, notLate } = lateWhere(company.overdueDays);
  const order = invoiceOrder(f.sort);

  const aggregate = Promise.all([
    db.invoice.aggregate({ where: { AND: [where, { status: 'ISSUED' }] }, _sum: { netTotal: true, grandTotal: true, paidTotal: true, openAmount: true } }),
    db.invoice.aggregate({ where: { AND: [where, OPEN, late] }, _sum: { openAmount: true }, _count: true }),
  ]);

  let rows: InvoiceListRow[] = [];
  let total = 0;
  if (order) {
    [rows, total] = await Promise.all([
      db.invoice.findMany({ where, orderBy: order, skip: page.skip, take: page.take, select: invoiceListSelect }),
      db.invoice.count({ where }),
    ]);
  } else {
    const groups: Array<{ where: Prisma.InvoiceWhereInput; orderBy: Prisma.InvoiceOrderByWithRelationInput[] }> = [
      { where: { AND: [where, OPEN, late] }, orderBy: [{ date: 'asc' }, { seq: 'asc' }] },
      { where: { AND: [where, OPEN, notLate] }, orderBy: [{ date: 'desc' }, { seq: 'desc' }] },
      { where: { AND: [where, { status: 'DRAFT' }] }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] },
      { where: { AND: [where, CLOSED] }, orderBy: [{ date: 'desc' }, { seq: 'desc' }, { createdAt: 'desc' }] },
    ];
    const counts = await Promise.all(groups.map((g) => db.invoice.count({ where: g.where })));
    total = counts.reduce((a, b) => a + b, 0);
    let skip = page.skip;
    let take = page.take;
    for (let i = 0; i < groups.length && take > 0; i++) {
      if (skip >= counts[i]) {
        skip -= counts[i];
        continue;
      }
      const part = await db.invoice.findMany({ where: groups[i].where, orderBy: groups[i].orderBy, skip, take, select: invoiceListSelect });
      rows = rows.concat(part);
      take -= part.length;
      skip = 0;
    }
  }
  const [sum, overdue] = await aggregate;
  return {
    rows,
    total,
    overdueDays: company.overdueDays,
    totals: {
      net: num(sum._sum.netTotal),
      issued: num(sum._sum.grandTotal),
      paid: num(sum._sum.paidTotal),
      open: num(sum._sum.openAmount),
      overdue: num(overdue._sum.openAmount),
      overdueCount: overdue._count,
    },
  };
}

// ================================================================ račun — kartica

export async function getInvoice(companyId: string, id: string) {
  return db.invoice.findFirst({
    where: { id, companyId },
    include: {
      partner: true,
      lines: {
        orderBy: { sort: 'asc' },
        include: {
          item: { select: { id: true, serial: true, state: true, warrantyMonths: true, warrantyStart: true } },
          model: { select: { code: true, kpd: true } },
          service: { select: { kpd: true } },
        },
      },
      payments: { orderBy: { date: 'asc' } },
      refInvoice: { select: { id: true, number: true, kind: true, date: true } },
      corrections: { where: { status: 'ISSUED' }, orderBy: { date: 'asc' }, select: { id: true, number: true, kind: true, date: true, grandTotal: true } },
      contract: { select: { id: true, number: true } },
      quote: { select: { id: true, number: true } },
    },
  });
}

export type InvoiceDetail = NonNullable<Awaited<ReturnType<typeof getInvoice>>>;

// ================================================================ editor — šifrarnici

export async function getCustomerOptions(companyId: string) {
  return db.partner.findMany({
    where: { companyId, isCustomer: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, city: true, country: true, note: true, paymentTermDays: true, excluded: true },
  });
}
export type CustomerOption = Awaited<ReturnType<typeof getCustomerOptions>>[number];

/** Sve što editori računa i ponude trebaju za odabir — kao obični objekti. */
export async function getSalesLookups(companyId: string) {
  const [company, lookups, partners] = await Promise.all([getCompany(companyId), getLookups(companyId), getCustomerOptions(companyId)]);
  return {
    partners,
    services: lookups.services.map((s) => ({ ...s, price: num(s.price) })),
    models: lookups.models.map((m) => ({
      id: m.id,
      brand: m.brand,
      name: m.name,
      categoryId: m.categoryId,
      salePrice: m.salePrice === null ? null : num(m.salePrice),
      warrantyMonths: m.warrantyMonths,
      kpd: m.kpd,
    })),
    categories: lookups.categories,
    warehouses: lookups.warehouses,
    company: {
      vatRegistered: company.vatRegistered,
      vatRate: num(company.vatRate),
      country: company.country,
      paymentTermDays: company.paymentTermDays,
      quoteValidDays: company.quoteValidDays,
      defaultWarrantyMonths: company.defaultWarrantyMonths,
      defaultMarginPct: num(company.defaultMarginPct),
    },
  };
}

// ================================================================ uređaji za račun / ponudu

export interface DeviceSearch {
  q?: string;
  modelId?: string | null;
  categoryId?: string | null;
  warehouseId?: string | null;
  partnerId?: string | null;
  itemIds?: string[];
  limit?: number;
}

export interface DeviceOption {
  id: string;
  serial: string;
  modelId: string;
  model: string;
  category: string | null;
  warehouse: string | null;
  state: string;
  status: string;
  cost: number;
  price: number;
  priceSource: 'agreed' | 'model' | 'margin';
  modelPrice: number | null;
  margin: number | null;
  warrantyMonths: number;
  kpd: string | null;
}

/**
 * Raspoloživi uređaji (na skladištu ili izašli iz skladišta) s preporučenom
 * cijenom za kupca: dogovorena → cijena modela → izračun iz marže.
 */
export async function searchDevices(companyId: string, s: DeviceSearch): Promise<DeviceOption[]> {
  const company = await getCompany(companyId);
  const q = s.q?.trim();
  const items = await db.item.findMany({
    where: {
      companyId,
      state: { in: ['IN_STOCK', 'RESERVED'] },
      contractItem: null,
      ...(s.itemIds ? { id: { in: s.itemIds } } : {}),
      ...(s.modelId ? { modelId: s.modelId } : {}),
      ...(s.categoryId ? { model: { categoryId: s.categoryId } } : {}),
      ...(s.warehouseId ? { warehouseId: s.warehouseId } : {}),
      ...(q
        ? {
            OR: [
              { serial: { contains: q, mode: 'insensitive' } },
              { model: { name: { contains: q, mode: 'insensitive' } } },
              { model: { brand: { contains: q, mode: 'insensitive' } } },
              { model: { code: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    orderBy: [{ model: { name: 'asc' } }, { serial: 'asc' }],
    take: s.itemIds ? undefined : (s.limit ?? 150),
    select: {
      id: true,
      serial: true,
      state: true,
      cost: true,
      marginPct: true,
      warrantyMonths: true,
      modelId: true,
      status: { select: { name: true } },
      warehouse: { select: { name: true } },
      model: { select: { brand: true, name: true, salePrice: true, marginPct: true, warrantyMonths: true, kpd: true, category: { select: { name: true } } } },
    },
  });
  const agreements = s.partnerId && items.length
    ? await db.priceAgreement.findMany({
        where: { companyId, partnerId: s.partnerId, modelId: { in: [...new Set(items.map((i) => i.modelId))] } },
        select: { modelId: true, salePrice: true },
      })
    : [];
  const agreed = new Map(agreements.map((a) => [a.modelId, a.salePrice === null ? null : num(a.salePrice)]));
  return items.map((i) => {
    const cost = num(i.cost);
    const modelPrice = i.model.salePrice === null ? null : num(i.model.salePrice);
    const p = suggestedSalePrice({
      agreed: agreed.get(i.modelId) ?? null,
      modelPrice,
      cost,
      itemMargin: i.marginPct === null ? null : num(i.marginPct),
      modelMargin: i.model.marginPct === null ? null : num(i.model.marginPct),
      companyMargin: num(company.defaultMarginPct),
    });
    return {
      id: i.id,
      serial: i.serial,
      modelId: i.modelId,
      model: modelLabel(i.model),
      category: i.model.category?.name ?? null,
      warehouse: i.warehouse?.name ?? null,
      state: i.state,
      status: i.status.name,
      cost,
      price: p.price,
      priceSource: p.source,
      modelPrice,
      margin: grossMargin(p.price, cost),
      warrantyMonths: i.warrantyMonths ?? i.model.warrantyMonths ?? company.defaultWarrantyMonths,
      kpd: i.model.kpd,
    };
  });
}

// ================================================================ ponude

export interface QuoteFilters {
  q: string;
  status: string;
  partner: string;
  year: string;
}

export function readQuoteFilters(sp: Params): QuoteFilters {
  return { q: str(sp.q), status: str(sp.status), partner: str(sp.partner), year: str(sp.godina) || today().slice(0, 4) };
}

const OPEN_QUOTE: QuoteStatus[] = ['DRAFT', 'SENT'];

export function quoteWhere(companyId: string, f: QuoteFilters, withStatus = true): Prisma.QuoteWhereInput {
  const t = fromISO(today());
  const and: Prisma.QuoteWhereInput[] = [{ companyId }];
  if (/^\d{4}$/.test(f.year)) and.push({ date: { gte: fromISO(`${f.year}-01-01`), lte: fromISO(`${f.year}-12-31`) } });
  if (f.partner) and.push({ partnerId: f.partner });
  if (f.q) {
    and.push({
      OR: [
        { number: { contains: f.q, mode: 'insensitive' } },
        { partner: { name: { contains: f.q, mode: 'insensitive' } } },
        { note: { contains: f.q, mode: 'insensitive' } },
      ],
    });
  }
  if (withStatus) {
    if (f.status === 'EXPIRED') and.push({ status: { in: OPEN_QUOTE }, validUntil: { lt: t } });
    else if (f.status === 'DRAFT' || f.status === 'SENT') and.push({ status: f.status, OR: [{ validUntil: null }, { validUntil: { gte: t } }] });
    else if (f.status === 'ACCEPTED' || f.status === 'REJECTED') and.push({ status: f.status });
  }
  return { AND: and };
}

export async function listQuotes(companyId: string, f: QuoteFilters, page: { skip: number; take: number }) {
  const where = quoteWhere(companyId, f);
  const all = quoteWhere(companyId, f, false);
  const [rows, total, byStatus, expired, sum] = await Promise.all([
    db.quote.findMany({
      where,
      orderBy: [{ date: 'desc' }, { number: 'desc' }],
      skip: page.skip,
      take: page.take,
      select: {
        id: true,
        number: true,
        date: true,
        validUntil: true,
        status: true,
        netTotal: true,
        grandTotal: true,
        partner: { select: { id: true, name: true } },
        invoice: { select: { id: true, number: true, status: true } },
        _count: { select: { lines: true } },
      },
    }),
    db.quote.count({ where }),
    db.quote.groupBy({ by: ['status'], where: all, _count: true }),
    db.quote.count({ where: { AND: [all, { status: { in: OPEN_QUOTE }, validUntil: { lt: fromISO(today()) } }] } }),
    db.quote.aggregate({ where, _sum: { netTotal: true, grandTotal: true } }),
  ]);
  const count = (s: QuoteStatus) => byStatus.find((b) => b.status === s)?._count ?? 0;
  const all_ = byStatus.reduce((a, b) => a + b._count, 0);
  return {
    rows,
    total,
    stats: {
      all: all_,
      accepted: count('ACCEPTED'),
      rejected: count('REJECTED'),
      open: count('DRAFT') + count('SENT') - expired,
      expired,
      rate: all_ ? (count('ACCEPTED') / all_) * 100 : null,
      net: num(sum._sum.netTotal),
      gross: num(sum._sum.grandTotal),
    },
  };
}

export async function getQuote(companyId: string, id: string) {
  return db.quote.findFirst({
    where: { id, companyId },
    include: {
      partner: true,
      invoice: { select: { id: true, number: true, status: true } },
      lines: {
        orderBy: { sort: 'asc' },
        include: {
          item: { select: { id: true, serial: true, state: true } },
          model: { select: { code: true } },
        },
      },
    },
  });
}

export type QuoteDetail = NonNullable<Awaited<ReturnType<typeof getQuote>>>;

/** Broj uređaja na skladištu po modelu — za stavke po modelu na ponudi. */
export async function stockByModel(companyId: string, modelIds: string[]) {
  if (!modelIds.length) return {} as Record<string, number>;
  const g = await db.item.groupBy({
    by: ['modelId'],
    where: { companyId, modelId: { in: modelIds }, state: { in: ['IN_STOCK', 'RESERVED'] }, contractItem: null },
    _count: true,
  });
  return Object.fromEntries(g.map((x) => [x.modelId, x._count])) as Record<string, number>;
}

/** Godine u kojima firma ima račune (za odabir godine), najnovija prva. */
export async function invoiceYears(companyId: string) {
  const g = await db.invoice.groupBy({ by: ['year'], where: { companyId }, orderBy: { year: 'desc' } });
  const years = g.map((x) => x.year);
  const cur = Number(today().slice(0, 4));
  if (!years.includes(cur)) years.unshift(cur);
  return years;
}
