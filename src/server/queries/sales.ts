import 'server-only';
import type { InvoiceKind, InvoiceType, Prisma, QuoteKind, QuoteStatus } from '@prisma/client';
import { db } from '../db';
import { getCompany, getLookups, getPartnerOptions, modelLabel } from './lookups';
import { addDays, fromISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { grossMargin, suggestedRent, suggestedSalePrice } from '@/domain/pricing';
import { parseMulti } from '@/lib/list-params';
import { EINVOICE_FILTER, einvoiceFilterValues, type EInvoiceFilter } from '@/domain/sales-lines';

type Params = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v.trim() : '');
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

// ================================================================ računi — filtri

export interface InvoiceFilters {
  q: string;
  year: string; // 'sve' ili godina
  /** Više odabira (?partner=a,b). */
  partner: string[];
  type: string[];
  kind: string[];
  pay: string[];
  /** Stanje eRačuna (?eracun=none,SENT…). */
  einvoice: EInvoiceFilter[];
  from: string;
  to: string;
  excluded: boolean;
  sort: string;
}

const TYPES = ['SALE', 'RENT', 'SERVICE'] as const;
const KINDS = ['INVOICE', 'ADVANCE', 'STORNO', 'CREDIT_NOTE', 'STORNOED'] as const;
const PAYS = ['open', 'overdue', 'notdue', 'partial', 'paid', 'draft'] as const;

export function readInvoiceFilters(sp: Params): InvoiceFilters {
  return {
    q: str(sp.q),
    year: str(sp.godina) || today().slice(0, 4),
    partner: parseMulti(sp, 'partner'),
    type: parseMulti(sp, 'vrsta', TYPES),
    kind: parseMulti(sp, 'dokument', KINDS),
    pay: parseMulti(sp, 'naplata', PAYS),
    einvoice: parseMulti(sp, 'eracun', EINVOICE_FILTER),
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

/**
 * Serijski broj u pretrazi: uređaji se pronalaze unaprijed (trigram indeks na
 * Item.serial), a računi preko njihovih stavki — bez spajanja cijelih tablica.
 */
export async function resolveInvoiceSearch(companyId: string, q: string): Promise<string[]> {
  if (q.trim().length < 3) return [];
  const items = await db.item.findMany({ where: { companyId, serial: { contains: q.trim(), mode: 'insensitive' } }, select: { id: true }, take: 500 });
  return items.map((i) => i.id);
}

export function invoiceWhere(companyId: string, f: InvoiceFilters, overdueDays: number, serialItemIds: string[] = []): Prisma.InvoiceWhereInput {
  const and: Prisma.InvoiceWhereInput[] = [{ companyId }];
  if (!f.excluded) and.push({ partner: { excluded: false } });
  if (f.year !== 'sve' && /^\d{4}$/.test(f.year)) and.push({ year: Number(f.year) });
  if (f.partner.length) and.push({ partnerId: { in: f.partner } });
  if (f.type.length) {
    // vrsta računa ili stavka te vrste (miješani račun: prodaja + najam)
    const types = f.type as InvoiceType[];
    and.push({ OR: [{ type: { in: types } }, { lines: { some: { lineType: { in: types } } } }] });
  }
  if (f.kind.length) {
    const kinds = f.kind.filter((k): k is InvoiceKind => k !== 'STORNOED');
    and.push({ OR: [...(kinds.length ? [{ kind: { in: kinds } }] : []), ...(f.kind.includes('STORNOED') ? [{ stornoed: true }] : [])] });
  }
  if (f.einvoice.length) {
    const { values, none } = einvoiceFilterValues(f.einvoice);
    and.push({ OR: [...(values.length ? [{ eInvoiceStatus: { in: values } }] : []), ...(none ? [{ status: 'ISSUED' as const, eInvoiceStatus: null }] : [])] });
  }
  if (isDate(f.from)) and.push({ date: { gte: fromISO(f.from) } });
  if (isDate(f.to)) and.push({ date: { lte: fromISO(f.to) } });
  if (f.q) {
    and.push({
      OR: [
        { number: { contains: f.q, mode: 'insensitive' } },
        { partner: { name: { contains: f.q, mode: 'insensitive' } } },
        { description: { contains: f.q, mode: 'insensitive' } },
        // opis stavke i serijski broj uređaja na računu
        { lines: { some: { description: { contains: f.q, mode: 'insensitive' } } } },
        ...(serialItemIds.length ? [{ lines: { some: { itemId: { in: serialItemIds } } } }] : []),
      ],
    });
  }
  if (f.pay.length) {
    const { late, notLate } = lateWhere(overdueDays);
    const or: Prisma.InvoiceWhereInput[] = [];
    for (const p of f.pay) {
      switch (p) {
        case 'draft':
          or.push({ status: 'DRAFT' });
          break;
        case 'open':
          or.push(OPEN);
          break;
        case 'overdue':
          or.push({ AND: [OPEN, late] });
          break;
        case 'notdue':
          or.push({ AND: [OPEN, notLate, { paidTotal: { lte: 0 } }] });
          break;
        case 'partial':
          or.push({ AND: [OPEN, { paidTotal: { gt: 0 } }] });
          break;
        case 'paid':
          or.push({ status: 'ISSUED', kind: { in: ['INVOICE', 'ADVANCE'] }, stornoed: false, openAmount: { lte: 0.005 }, grandTotal: { gt: 0 } });
          break;
      }
    }
    if (or.length) and.push({ OR: or });
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
  fiscalStatus: true,
  eInvoiceStatus: true,
  period: true,
  refInvoice: { select: { eInvoiceStatus: true } },
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
  const [company, serialIds] = await Promise.all([getCompany(companyId), f.q ? resolveInvoiceSearch(companyId, f.q) : Promise.resolve([])]);
  const where = invoiceWhere(companyId, f, company.overdueDays, serialIds);
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

/**
 * Storno i odobrenja uz račune koji su već poslani posredniku, a sami još nisu
 * poslani — dok ne stignu posredniku, izvorni račun kod Porezne uprave vrijedi u punom iznosu.
 */
export async function unsentCorrections(companyId: string) {
  const where: Prisma.InvoiceWhereInput = {
    companyId,
    status: 'ISSUED',
    kind: { in: ['STORNO', 'CREDIT_NOTE'] },
    eInvoiceStatus: null,
    refInvoice: { eInvoiceStatus: { not: null } },
  };
  const [rows, total] = await Promise.all([
    db.invoice.findMany({ where, orderBy: [{ date: 'desc' }], take: 10, select: { id: true, number: true, kind: true } }),
    db.invoice.count({ where }),
  ]);
  return { rows, total };
}

/** Uređaji koji su izašli iz skladišta i čekaju račun, najam ili ugovor — po kupcu kojem idu. */
export async function pendingOut(companyId: string) {
  const groups = await db.item.groupBy({ by: ['outPartnerId'], where: { companyId, state: 'RESERVED' }, _count: true });
  if (!groups.length) return { total: 0, groups: [] as Array<{ partnerId: string | null; partnerName: string | null; count: number; itemIds: string[] }> };
  const partnerIds = groups.map((g) => g.outPartnerId).filter((x): x is string => !!x);
  const [partners, items] = await Promise.all([
    partnerIds.length ? db.partner.findMany({ where: { companyId, id: { in: partnerIds } }, select: { id: true, name: true } }) : [],
    // id-evi za poveznice (najviše 200 po skupini — za više ide popis u Skladište → Izlaz)
    db.item.findMany({ where: { companyId, state: 'RESERVED' }, orderBy: { outAt: 'desc' }, take: 1000, select: { id: true, outPartnerId: true } }),
  ]);
  const name = new Map(partners.map((p) => [p.id, p.name]));
  const ids = new Map<string, string[]>();
  for (const i of items) {
    const k = i.outPartnerId ?? '';
    const list = ids.get(k) ?? [];
    if (list.length < 200) list.push(i.id);
    ids.set(k, list);
  }
  const out = groups
    .map((g) => ({ partnerId: g.outPartnerId, partnerName: g.outPartnerId ? (name.get(g.outPartnerId) ?? null) : null, count: g._count, itemIds: ids.get(g.outPartnerId ?? '') ?? [] }))
    .sort((a, b) => b.count - a.count);
  return { total: out.reduce((a, g) => a + g.count, 0), groups: out };
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
          item: { select: { id: true, serial: true, state: true, warrantyMonths: true, warrantyStart: true, contractItem: { select: { contractId: true } } } },
          model: { select: { code: true, kpd: true } },
          service: { select: { kpd: true } },
        },
      },
      payments: { orderBy: { date: 'asc' } },
      refInvoice: { select: { id: true, number: true, kind: true, date: true, eInvoiceStatus: true } },
      corrections: { where: { status: 'ISSUED' }, orderBy: { date: 'asc' }, select: { id: true, number: true, kind: true, date: true, grandTotal: true, eInvoiceStatus: true } },
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
    select: { id: true, name: true, city: true, country: true, note: true, paymentTermDays: true, excluded: true, vatCategoryOverride: true },
  });
}
export type CustomerOption = Awaited<ReturnType<typeof getCustomerOptions>>[number];

/** Sve što editori računa i ponude trebaju za odabir — kao obični objekti. */
export async function getSalesLookups(companyId: string) {
  const [company, lookups, partners, suppliers, kpdRent] = await Promise.all([
    getCompany(companyId),
    getLookups(companyId),
    getCustomerOptions(companyId),
    getPartnerOptions(companyId, 'supplier'),
    db.deviceModel.findMany({ where: { companyId, active: true, kpdRent: { not: null } }, select: { id: true, kpdRent: true } }),
  ]);
  const rentKpd = new Map(kpdRent.map((m) => [m.id, m.kpdRent]));
  return {
    partners,
    services: lookups.services.map((s) => ({ ...s, price: num(s.price) })),
    models: lookups.models.map((m) => ({
      id: m.id,
      brand: m.brand,
      name: m.name,
      categoryId: m.categoryId,
      salePrice: m.salePrice === null ? null : num(m.salePrice),
      rentPrice: m.rentPrice === null ? null : num(m.rentPrice),
      warrantyMonths: m.warrantyMonths,
      kpd: m.kpd,
      kpdRent: rentKpd.get(m.id) ?? null,
    })),
    categories: lookups.categories,
    warehouses: lookups.warehouses,
    suppliers: suppliers.map((p) => ({ id: p.id, name: p.name })),
    // birač uređaja: statusi raspoloživih uređaja i statusi najma
    statuses: lookups.statuses.filter((x) => ['IN_STOCK', 'RESERVED', 'RENTED'].includes(x.kind)).map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
    company: {
      vatRegistered: company.vatRegistered,
      vatRate: num(company.vatRate),
      country: company.country,
      paymentTermDays: company.paymentTermDays,
      quoteValidDays: company.quoteValidDays,
      defaultWarrantyMonths: company.defaultWarrantyMonths,
      defaultMarginPct: num(company.defaultMarginPct),
      rentFallbackPct: num(company.rentFallbackPct),
      kpdSale: company.kpdSale,
      kpdRent: company.kpdRent,
      kpdService: company.kpdService,
      proformaTitle: company.proformaTitle,
    },
  };
}

// ================================================================ uređaji za račun / ponudu

export interface DeviceSearch {
  q?: string;
  modelId?: string | null;
  categoryId?: string | null;
  warehouseId?: string | null;
  supplierId?: string | null;
  statusId?: string | null;
  partnerId?: string | null;
  itemIds?: string[];
  /** stock = na skladištu ili izašlo (zadano); rented = postojeći najmovi (uređaji na ugovorima). */
  mode?: 'stock' | 'rented';
  /** Postojeći najmovi: samo uređaji ovog kupca (partnerId). */
  onlyPartner?: boolean;
  limit?: number;
}

export interface DeviceOption {
  id: string;
  serial: string;
  modelId: string;
  model: string;
  category: string | null;
  warehouse: string | null;
  supplier: string | null;
  state: string;
  status: string;
  cost: number;
  price: number;
  priceSource: 'agreed' | 'model' | 'margin';
  modelPrice: number | null;
  margin: number | null;
  /** Preporučeni mjesečni najam (dogovoreni → uređaj → model → % nabavne); kod postojećeg najma cijena s ugovora. */
  rent: number;
  rentSource: 'agreed' | 'item' | 'model' | 'cost' | 'contract';
  /** Postojeći najam: ugovor na kojem je uređaj. */
  contractId: string | null;
  contractNumber: string | null;
  holder: string | null;
  warrantyMonths: number;
  kpd: string | null;
  kpdRent: string | null;
}

/**
 * Uređaji za račun / ponudu s preporučenom cijenom za kupca: dogovorena →
 * cijena modela → izračun iz marže, i mjesečnim najmom. Zadano raspoloživi
 * (na skladištu ili izašli iz skladišta); `mode: 'rented'` = postojeći najmovi.
 */
export async function searchDevices(companyId: string, s: DeviceSearch): Promise<DeviceOption[]> {
  const company = await getCompany(companyId);
  const q = s.q?.trim();
  const rented = s.mode === 'rented';
  const items = await db.item.findMany({
    where: {
      companyId,
      ...(rented
        ? { state: 'RENTED', contractItem: { isNot: null }, ...(s.onlyPartner && s.partnerId ? { partnerId: s.partnerId } : {}) }
        : { state: { in: ['IN_STOCK', 'RESERVED'] }, contractItem: null }),
      ...(s.itemIds ? { id: { in: s.itemIds } } : {}),
      ...(s.modelId ? { modelId: s.modelId } : {}),
      ...(s.categoryId ? { model: { categoryId: s.categoryId } } : {}),
      ...(s.warehouseId ? { warehouseId: s.warehouseId } : {}),
      ...(s.supplierId ? { supplierId: s.supplierId } : {}),
      ...(s.statusId ? { statusId: s.statusId } : {}),
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
      rentPrice: true,
      warrantyMonths: true,
      modelId: true,
      status: { select: { name: true } },
      warehouse: { select: { name: true } },
      supplier: { select: { name: true } },
      partner: { select: { name: true } },
      contractItem: { select: { monthly: true, contract: { select: { id: true, number: true } } } },
      model: { select: { brand: true, name: true, salePrice: true, rentPrice: true, marginPct: true, warrantyMonths: true, kpd: true, kpdRent: true, category: { select: { name: true } } } },
    },
  });
  const agreements = s.partnerId && items.length
    ? await db.priceAgreement.findMany({
        where: { companyId, partnerId: s.partnerId, modelId: { in: [...new Set(items.map((i) => i.modelId))] } },
        select: { modelId: true, salePrice: true, rentPrice: true },
      })
    : [];
  const agreed = new Map(agreements.map((a) => [a.modelId, a]));
  return items.map((i) => {
    const cost = num(i.cost);
    const modelPrice = i.model.salePrice === null ? null : num(i.model.salePrice);
    const a = agreed.get(i.modelId);
    const p = suggestedSalePrice({
      agreed: a?.salePrice == null ? null : num(a.salePrice),
      modelPrice,
      cost,
      itemMargin: i.marginPct === null ? null : num(i.marginPct),
      modelMargin: i.model.marginPct === null ? null : num(i.model.marginPct),
      companyMargin: num(company.defaultMarginPct),
    });
    const r = i.contractItem
      ? { price: num(i.contractItem.monthly), source: 'contract' as const }
      : suggestedRent({
          agreed: a?.rentPrice == null ? null : num(a.rentPrice),
          itemRent: i.rentPrice == null ? null : num(i.rentPrice),
          modelRent: i.model.rentPrice == null ? null : num(i.model.rentPrice),
          cost,
          fallbackPct: num(company.rentFallbackPct),
        });
    return {
      id: i.id,
      serial: i.serial,
      modelId: i.modelId,
      model: modelLabel(i.model),
      category: i.model.category?.name ?? null,
      warehouse: i.warehouse?.name ?? null,
      supplier: i.supplier?.name ?? null,
      state: i.state,
      status: i.status.name,
      cost,
      price: p.price,
      priceSource: p.source,
      modelPrice,
      margin: grossMargin(p.price, cost),
      rent: r.price,
      rentSource: r.source,
      contractId: i.contractItem?.contract.id ?? null,
      contractNumber: i.contractItem?.contract.number ?? null,
      holder: rented ? (i.partner?.name ?? null) : null,
      warrantyMonths: i.warrantyMonths ?? i.model.warrantyMonths ?? company.defaultWarrantyMonths,
      kpd: i.model.kpd,
      kpdRent: i.model.kpdRent,
    };
  });
}

/** Bez prava „costs" nabavna cijena i marža ne idu u preglednik. */
export const hideDeviceCost = (rows: DeviceOption[], see: boolean): DeviceOption[] => (see ? rows : rows.map((r) => ({ ...r, cost: 0, margin: null })));

// ================================================================ ponude

export interface QuoteFilters {
  q: string;
  status: string;
  partner: string;
  year: string;
  /** QUOTE (ponude), PROFORMA (predračuni) ili '' (sve). */
  kind: string;
}

export function readQuoteFilters(sp: Params): QuoteFilters {
  const kind = str(sp.vrsta);
  return { q: str(sp.q), status: str(sp.status), partner: str(sp.partner), year: str(sp.godina) || today().slice(0, 4), kind: kind === 'QUOTE' || kind === 'PROFORMA' ? kind : '' };
}

const OPEN_QUOTE: QuoteStatus[] = ['DRAFT', 'SENT'];

export function quoteWhere(companyId: string, f: QuoteFilters, withStatus = true): Prisma.QuoteWhereInput {
  const t = fromISO(today());
  const and: Prisma.QuoteWhereInput[] = [{ companyId }];
  if (/^\d{4}$/.test(f.year)) and.push({ date: { gte: fromISO(`${f.year}-01-01`), lte: fromISO(`${f.year}-12-31`) } });
  if (f.partner) and.push({ partnerId: f.partner });
  if (f.kind) and.push({ kind: f.kind as QuoteKind });
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
        kind: true,
        number: true,
        date: true,
        validUntil: true,
        status: true,
        note: true,
        contract: { select: { id: true, number: true } },
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
      contract: { select: { id: true, number: true } },
      lines: {
        orderBy: { sort: 'asc' },
        include: {
          item: { select: { id: true, serial: true, state: true, contractItem: { select: { contractId: true } } } },
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
