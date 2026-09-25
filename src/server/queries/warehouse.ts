import 'server-only';
import { Prisma, type StatusKind } from '@prisma/client';
import { db } from '../db';
import { toDevice, toTerms } from '../services/rentals';
import { planSummary, returnReason } from '@/domain/billing';
import { num } from '@/domain/money';
import { today } from '@/domain/dates';
import { inOrAll, parseMulti, parseSort, sortOrderBy } from '@/lib/list-params';
import { ITEM_SORTS, type ItemSort } from '@/domain/warehouse-list';

type Params = Record<string, string | string[] | undefined>;

const STATE_KINDS: StatusKind[] = ['IN_STOCK', 'RESERVED', 'SOLD', 'RENTED', 'SERVICE', 'RETURNING', 'WRITTEN_OFF', 'OTHER'];

export interface ItemFilters {
  q: string | null;
  statusIds: string[];
  state: StatusKind | null;
  modelIds: string[];
  categoryIds: string[];
  warehouseIds: string[];
  supplierId: string | null;
  partnerId: string | null;
  years: number[];
  cpu: string[];
  screen: string[];
  os: string[];
  sort: { sort: ItemSort; dir: 'asc' | 'desc' } | null;
}

const str = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Filtri popisa uređaja iz URL-a (više vrijednosti odvojeno zarezom). */
export function parseItemFilters(p: Params): ItemFilters {
  const state = str(p.state);
  return {
    q: str(p.q),
    statusIds: parseMulti(p, 'status'),
    state: state && (STATE_KINDS as string[]).includes(state) ? (state as StatusKind) : null,
    modelIds: parseMulti(p, 'model'),
    categoryIds: parseMulti(p, 'category'),
    warehouseIds: parseMulti(p, 'warehouse'),
    supplierId: str(p.supplier),
    partnerId: str(p.partner),
    years: parseMulti(p, 'year').map(Number).filter((y) => Number.isInteger(y) && y > 1900 && y < 3000),
    cpu: parseMulti(p, 'cpu'),
    screen: parseMulti(p, 'screen'),
    os: parseMulti(p, 'os'),
    sort: parseSort(p, ITEM_SORTS),
  };
}

/** Modeli i partneri čiji naziv odgovara pretrazi — razrješavaju se unaprijed (male tablice). */
export interface SearchIds {
  modelIds: string[];
  partnerIds: string[];
  /** Modeli odabranih kategorija (kategorija uređaja je vlastita ili modelova). */
  categoryModelIds?: string[];
}

export async function resolveSearch(companyId: string, q: string | null, categoryIds: string[] = []): Promise<SearchIds | undefined> {
  if (!q && !categoryIds.length) return undefined;
  const contains = q ? { contains: q, mode: 'insensitive' as const } : null;
  const [models, partners, catModels] = await Promise.all([
    contains ? db.deviceModel.findMany({ where: { companyId, OR: [{ name: contains }, { brand: contains }] }, select: { id: true }, take: 500 }) : [],
    contains ? db.partner.findMany({ where: { companyId, name: contains }, select: { id: true }, take: 500 }) : [],
    categoryIds.length ? db.deviceModel.findMany({ where: { companyId, categoryId: { in: categoryIds } }, select: { id: true } }) : [],
  ]);
  return { modelIds: models.map((m) => m.id), partnerIds: partners.map((p) => p.id), categoryModelIds: catModels.map((m) => m.id) };
}

/**
 * Prisma `where` za popis uređaja — uvijek sužen na firmu. Pretraga koristi
 * samo stupce uređaja (serijski i napomene imaju trigram indekse, model i
 * partner b-stablo), pa baza može spojiti indekse umjesto čitanja cijele tablice.
 */
export function itemWhere(companyId: string, f: ItemFilters, opts: { ignoreState?: boolean; search?: SearchIds } = {}): Prisma.ItemWhereInput {
  const and: Prisma.ItemWhereInput[] = [];
  if (f.q) {
    const contains = { contains: f.q, mode: 'insensitive' as const };
    const or: Prisma.ItemWhereInput[] = [{ serial: contains }, { note: contains }, { dupNote: contains }];
    if (opts.search?.modelIds.length) or.push({ modelId: { in: opts.search.modelIds } });
    if (opts.search?.partnerIds.length) or.push({ partnerId: { in: opts.search.partnerIds } });
    and.push({ OR: or });
  }
  if (f.categoryIds.length) {
    // kategorija po komadu ima prednost; bez nje vrijedi kategorija modela
    const or: Prisma.ItemWhereInput[] = [{ categoryId: { in: f.categoryIds } }];
    const mids = opts.search?.categoryModelIds ?? [];
    if (mids.length) or.push({ categoryId: null, modelId: { in: mids } });
    and.push({ OR: or });
  }
  if (f.years.length) {
    and.push({ OR: f.years.map((y) => ({ importDate: { gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) } })) });
  }
  return {
    companyId,
    ...(f.statusIds.length ? { statusId: inOrAll(f.statusIds) } : {}),
    ...(f.state && !opts.ignoreState ? { state: f.state } : {}),
    ...(f.modelIds.length ? { modelId: inOrAll(f.modelIds) } : {}),
    ...(f.warehouseIds.length ? { warehouseId: inOrAll(f.warehouseIds) } : {}),
    ...(f.supplierId ? { supplierId: f.supplierId } : {}),
    ...(f.partnerId ? { partnerId: f.partnerId } : {}),
    ...(f.cpu.length ? { cpu: inOrAll(f.cpu) } : {}),
    ...(f.screen.length ? { screen: inOrAll(f.screen) } : {}),
    ...(f.os.length ? { os: inOrAll(f.os) } : {}),
    ...(and.length ? { AND: and } : {}),
  };
}

/** Redoslijed popisa: zadano najnoviji upis; sortiranje samo po stupcima uređaja (ITEM_SORTS). */
function itemOrder(f: ItemFilters): Prisma.ItemOrderByWithRelationInput[] {
  if (!f.sort) return [{ createdAt: 'desc' }, { id: 'desc' }];
  const last = (dir: 'asc' | 'desc') => ({ sort: dir, nulls: 'last' as const });
  const map: Record<ItemSort, (d: 'asc' | 'desc') => Prisma.ItemOrderByWithRelationInput> = {
    serijski: (d) => ({ serial: d }),
    uvoz: (d) => ({ importDate: last(d) }),
    izdano: (d) => ({ issueDate: last(d) }),
    nabavna: (d) => ({ cost: d }),
  };
  return sortOrderBy(f.sort, map, { id: 'desc' }) ?? [];
}

const listSelect = {
  id: true,
  serial: true,
  dupNote: true,
  state: true,
  cost: true,
  salePrice: true,
  rentPrice: true,
  marginPct: true,
  cpu: true,
  screen: true,
  os: true,
  importDate: true,
  issueDate: true,
  warrantyStart: true,
  warrantyMonths: true,
  note: true,
  model: { select: { brand: true, name: true, salePrice: true, rentPrice: true, marginPct: true, warrantyMonths: true, category: { select: { name: true } } } },
  category: { select: { name: true } },
  status: { select: { name: true, color: true } },
  warehouse: { select: { name: true } },
  partner: { select: { id: true, name: true } },
  invoice: { select: { id: true, number: true, date: true } },
  contractItem: { select: { contractId: true, contract: { select: { number: true } } } },
} satisfies Prisma.ItemSelect;

/** Stranica popisa, ukupan broj, vrijednost filtriranog skupa i brojevi po stanju. */
export async function listItems(companyId: string, f: ItemFilters, page: { skip: number; take: number }) {
  const search = await resolveSearch(companyId, f.q, f.categoryIds);
  const where = itemWhere(companyId, f, { search });
  const orderBy = itemOrder(f);
  const [rows, agg, byState] = await Promise.all([
    db.item.findMany({ where, select: listSelect, orderBy, skip: page.skip, take: page.take }),
    db.item.aggregate({ where, _count: { _all: true }, _sum: { cost: true } }),
    db.item.groupBy({ by: ['state'], where: itemWhere(companyId, f, { ignoreState: true, search }), _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(byState.map((s) => [s.state, s._count._all])) as Partial<Record<StatusKind, number>>;
  return { rows, total: agg._count._all, costSum: num(agg._sum.cost), counts };
}

export type ItemListRow = Awaited<ReturnType<typeof listItems>>['rows'][number];

/** Svi filtrirani uređaji za izvoz (s gornjom granicom radi zaštite). */
export async function exportItems(companyId: string, f: ItemFilters) {
  return db.item.findMany({
    where: itemWhere(companyId, f, { search: await resolveSearch(companyId, f.q, f.categoryIds) }),
    orderBy: itemOrder(f),
    take: 100_000,
    select: {
      ...listSelect,
      supplier: { select: { name: true } },
    },
  });
}

/**
 * Vrijednosti za filtre (godine uvoza, procesor, ekran, OS) jednim prolazom
 * kroz uređaje firme — zamjenjuje zaseban upit godina, pa popis nije sporiji.
 */
export async function itemFacets(companyId: string): Promise<{ years: number[]; cpu: string[]; screen: string[]; os: string[] }> {
  const [r] = await db.$queryRaw<{ years: number[] | null; cpu: string[] | null; screen: string[] | null; os: string[] | null }[]>`
    SELECT array_agg(DISTINCT EXTRACT(YEAR FROM "importDate")::int) FILTER (WHERE "importDate" IS NOT NULL) AS years,
           (array_agg(DISTINCT "cpu") FILTER (WHERE "cpu" IS NOT NULL AND "cpu" <> ''))[1:200] AS cpu,
           (array_agg(DISTINCT "screen") FILTER (WHERE "screen" IS NOT NULL AND "screen" <> ''))[1:200] AS screen,
           (array_agg(DISTINCT "os") FILTER (WHERE "os" IS NOT NULL AND "os" <> ''))[1:200] AS os
    FROM "Item" WHERE "companyId" = ${companyId}`;
  const sortHr = (a: string[] | null | undefined) => [...(a ?? [])].sort((x, y) => x.localeCompare(y, 'hr'));
  return {
    years: [...(r?.years ?? [])].map(Number).sort((a, b) => b - a),
    cpu: sortHr(r?.cpu),
    screen: sortHr(r?.screen),
    os: sortHr(r?.os),
  };
}

/** Kartica uređaja sa svime što se na njoj prikazuje. */
export async function getItemCard(companyId: string, id: string) {
  const item = await db.item.findFirst({
    where: { id, companyId },
    include: {
      model: {
        select: {
          id: true, brand: true, name: true, warrantyMonths: true, salePrice: true, rentPrice: true, marginPct: true, cpu: true, screen: true, os: true,
          category: { select: { id: true, name: true } },
        },
      },
      category: { select: { id: true, name: true } },
      status: { select: { id: true, name: true, color: true, kind: true } },
      warehouse: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
      partner: { select: { id: true, name: true } },
      invoice: { select: { id: true, number: true, date: true } },
      receipt: { select: { id: true, number: true } },
      contractItem: { include: { contract: true } },
    },
  });
  if (!item) return null;

  const [events, earnings, serviceOrders, duplicates, outPartner, outBy, company] = await Promise.all([
    db.itemEvent.findMany({ where: { itemId: id, companyId }, orderBy: { at: 'desc' }, take: 300 }),
    db.invoiceLine.aggregate({
      where: { itemId: id, invoice: { companyId, status: 'ISSUED', kind: 'INVOICE', stornoed: false } },
      _sum: { netAmount: true },
      _count: { _all: true },
    }),
    db.serviceOrder.findMany({
      where: { companyId, itemId: id },
      orderBy: { reportedAt: 'desc' },
      select: { id: true, number: true, status: true, reportedAt: true, closedAt: true, issue: true },
    }),
    db.item.findMany({
      where: { companyId, serial: item.serial, id: { not: id } },
      select: { id: true, serial: true, dupNote: true, status: { select: { name: true } } },
      take: 20,
    }),
    item.outPartnerId ? db.partner.findFirst({ where: { id: item.outPartnerId, companyId }, select: { id: true, name: true } }) : null,
    item.outById ? db.user.findFirst({ where: { id: item.outById, companyId }, select: { name: true } }) : null,
    db.company.findUniqueOrThrow({ where: { id: companyId }, select: { defaultWarrantyMonths: true, defaultMarginPct: true } }),
  ]);

  const ci = item.contractItem;
  const contract = ci
    ? {
        id: ci.contract.id,
        number: ci.contract.number,
        status: ci.contract.status,
        monthly: num(ci.monthly),
        plan: planSummary(toTerms(ci.contract), toDevice(ci)),
        startDate: ci.contract.startDate,
        endDate: ci.contract.endDate,
        returnReason: returnReason(toTerms(ci.contract), toDevice(ci)),
      }
    : null;

  return {
    item,
    contract,
    events,
    earned: num(earnings._sum.netAmount),
    earnedLines: earnings._count._all,
    serviceOrders,
    duplicates,
    outPartner,
    outByName: outBy?.name ?? null,
    defaultWarrantyMonths: company.defaultWarrantyMonths,
    defaultMarginPct: num(company.defaultMarginPct),
  };
}

// ---------------------------------------------------------------- izlaz i povrat

/** Uređaji koji su izašli iz skladišta, grupirani po partneru kojem idu. */
export async function reservedGroups(companyId: string) {
  const items = await db.item.findMany({
    where: { companyId, state: 'RESERVED' },
    orderBy: [{ outAt: 'desc' }, { serial: 'asc' }],
    select: {
      id: true,
      serial: true,
      cost: true,
      outAt: true,
      outById: true,
      outPartnerId: true,
      outNote: true,
      model: { select: { brand: true, name: true } },
      warehouse: { select: { name: true } },
    },
  });
  const partnerIds = [...new Set(items.map((i) => i.outPartnerId).filter((x): x is string => !!x))];
  const userIds = [...new Set(items.map((i) => i.outById).filter((x): x is string => !!x))];
  const [partners, users] = await Promise.all([
    partnerIds.length ? db.partner.findMany({ where: { companyId, id: { in: partnerIds } }, select: { id: true, name: true } }) : [],
    userIds.length ? db.user.findMany({ where: { companyId, id: { in: userIds } }, select: { id: true, name: true } }) : [],
  ]);
  const pName = new Map(partners.map((p) => [p.id, p.name]));
  const uName = new Map(users.map((u) => [u.id, u.name]));
  const groups = new Map<string, { partnerId: string | null; partnerName: string | null; items: Array<(typeof items)[number] & { outByName: string | null }> }>();
  for (const i of items) {
    const key = i.outPartnerId ?? '';
    if (!groups.has(key)) groups.set(key, { partnerId: i.outPartnerId, partnerName: i.outPartnerId ? pName.get(i.outPartnerId) ?? null : null, items: [] });
    groups.get(key)!.items.push({ ...i, outByName: i.outById ? uName.get(i.outById) ?? null : null });
  }
  return [...groups.values()].sort((a, b) => (a.partnerName ?? '￿').localeCompare(b.partnerName ?? '￿', 'hr'));
}

/** Uređaji na ugovorima koji bi se trebali vratiti (istek, raskid, kraj sezone ili plana). */
export async function returnCandidates(companyId: string) {
  const contracts = await db.contract.findMany({
    where: { companyId, status: { in: ['ACTIVE', 'EXPIRED', 'TERMINATED'] }, items: { some: { item: { state: { not: 'RETURNING' } } } } },
    include: {
      partner: { select: { id: true, name: true } },
      items: {
        where: { item: { state: { not: 'RETURNING' } } },
        include: { item: { select: { id: true, serial: true, state: true, model: { select: { brand: true, name: true } } } } },
      },
    },
  });
  const now = today();
  const out: Array<{
    itemId: string;
    serial: string;
    model: string;
    contractId: string;
    contractNumber: string;
    partner: { id: string; name: string };
    reason: string;
  }> = [];
  for (const c of contracts) {
    const terms = toTerms(c);
    for (const ci of c.items) {
      const reason = returnReason(terms, toDevice(ci), now);
      if (!reason) continue;
      out.push({
        itemId: ci.item.id,
        serial: ci.item.serial,
        model: [ci.item.model.brand, ci.item.model.name].filter(Boolean).join(' '),
        contractId: c.id,
        contractNumber: c.number,
        partner: c.partner,
        reason,
      });
    }
  }
  return out.sort((a, b) => a.partner.name.localeCompare(b.partner.name, 'hr') || a.serial.localeCompare(b.serial));
}

/** Uređaji u dolasku (najavljen povrat). */
export function returningItems(companyId: string) {
  return db.item.findMany({
    where: { companyId, state: 'RETURNING' },
    orderBy: [{ updatedAt: 'desc' }],
    select: {
      id: true,
      serial: true,
      updatedAt: true,
      model: { select: { brand: true, name: true } },
      partner: { select: { id: true, name: true } },
      contractItem: { select: { contract: { select: { id: true, number: true } } } },
    },
  });
}

/** Ručni povrat: uređaji izvan skladišta po serijskom broju. */
export function outsideItems(companyId: string, q: string | null) {
  if (!q) return Promise.resolve([]);
  return db.item.findMany({
    where: { companyId, state: { in: ['SOLD', 'RENTED', 'OTHER'] }, serial: { contains: q, mode: 'insensitive' } },
    orderBy: { serial: 'asc' },
    take: 100,
    select: {
      id: true,
      serial: true,
      dupNote: true,
      model: { select: { brand: true, name: true } },
      status: { select: { name: true, color: true } },
      partner: { select: { id: true, name: true } },
      issueDate: true,
    },
  });
}

export async function outCounts(companyId: string) {
  const rows = await db.item.groupBy({ by: ['state'], where: { companyId, state: { in: ['RESERVED', 'RETURNING'] } }, _count: { _all: true } });
  const m = Object.fromEntries(rows.map((r) => [r.state, r._count._all]));
  return { reserved: m.RESERVED ?? 0, returning: m.RETURNING ?? 0 };
}

// ---------------------------------------------------------------- međuskladišnice

export async function listTransfers(companyId: string, page: { skip: number; take: number }, q: string | null) {
  const where: Prisma.TransferWhereInput = {
    companyId,
    ...(q ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { items: { some: { item: { serial: { contains: q, mode: 'insensitive' } } } } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.transfer.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip: page.skip,
      take: page.take,
      select: {
        id: true,
        number: true,
        date: true,
        note: true,
        createdBy: true,
        fromWarehouse: { select: { name: true } },
        toWarehouse: { select: { name: true } },
        _count: { select: { items: true } },
      },
    }),
    db.transfer.count({ where }),
  ]);
  return { rows, total };
}

export function getTransfer(companyId: string, id: string) {
  return db.transfer.findFirst({
    where: { id, companyId },
    include: {
      fromWarehouse: { select: { name: true, address: true } },
      toWarehouse: { select: { name: true, address: true } },
      items: {
        select: {
          item: { select: { id: true, serial: true, dupNote: true, cost: true, model: { select: { brand: true, name: true, code: true } } } },
        },
        orderBy: { item: { serial: 'asc' } },
      },
    },
  });
}
