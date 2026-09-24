import 'server-only';
import type { Contract, Prisma, StatusKind } from '@prisma/client';
import { db } from '../db';
import { coveredPeriods } from '../services/invoices';
import { pendingForCompany, returnedWhere, toDevice, toReturnedDevice, toTerms } from '../services/rentals';
import { nextBillingDate, pendingInstallments, type BillingCode, type ContractStatusCode } from '@/domain/billing';
import { suggestedRent } from '@/domain/pricing';
import { num } from '@/domain/money';
import { today } from '@/domain/dates';

type Params = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v.trim() : '');

export const CONTRACT_STATUSES: ContractStatusCode[] = ['ACTIVE', 'PAUSED', 'EXPIRED', 'TERMINATED'];
export const BILLINGS: BillingCode[] = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ONCE'];

// ---------------------------------------------------------------- popis ugovora

/** Filtri popisa ugovora iz URL-a → Prisma where (sve u bazi). */
export function contractWhere(companyId: string, params: Params): Prisma.ContractWhereInput {
  const and: Prisma.ContractWhereInput[] = [{ companyId }];
  const q = str(params.q);
  const status = str(params.status);
  const partner = str(params.partner);
  const billing = str(params.billing);
  if (q) and.push({ OR: [{ number: { contains: q, mode: 'insensitive' } }, { partner: { name: { contains: q, mode: 'insensitive' } } }] });
  if (CONTRACT_STATUSES.includes(status as ContractStatusCode)) and.push({ status: status as ContractStatusCode });
  if (partner) and.push({ partnerId: partner });
  if (BILLINGS.includes(billing as BillingCode)) and.push({ billing: billing as BillingCode });
  // isključeni partneri skriveni su, osim kad se izričito traže (ili se filtrira baš po njemu)
  if (str(params.iskljuceni) !== '1' && !partner) and.push({ partner: { excluded: false } });
  return { AND: and };
}

/**
 * Stranica popisa: zbrojevi po ugovoru iz baze (groupBy), a sljedeća naplata i
 * broj rata za izdati motorom naplate — samo za ugovore na ovoj stranici.
 */
export async function listContracts(companyId: string, params: Params, page: { skip: number; take: number }) {
  const where = contractWhere(companyId, params);
  const [total, contracts, totals] = await Promise.all([
    db.contract.count({ where }),
    db.contract.findMany({
      where,
      orderBy: [{ startDate: 'desc' }, { number: 'desc' }],
      skip: page.skip,
      take: page.take,
      include: { partner: { select: { id: true, name: true, excluded: true } } },
    }),
    db.contractItem.aggregate({ where: { contract: where }, _sum: { monthly: true }, _count: true }),
  ]);
  const ids = contracts.map((c) => c.id);
  // rate za izdati imaju aktivni ugovori i oni zatvoreni u programu (zaostale rate)
  const activeIds = contracts.filter((c) => c.status === 'ACTIVE' || (c.status !== 'PAUSED' && c.closedAt)).map((c) => c.id);
  const now = today();
  const [sums, items, returned, covered] = await Promise.all([
    db.contractItem.groupBy({ by: ['contractId'], where: { contractId: { in: ids } }, _sum: { monthly: true }, _count: { _all: true } }),
    db.contractItem.findMany({ where: { contractId: { in: activeIds } } }),
    db.returnedContractItem.findMany({ where: { contractId: { in: activeIds }, ...returnedWhere(now) } }),
    coveredPeriods(db, activeIds),
  ]);
  const sumBy = new Map(sums.map((s) => [s.contractId, { monthly: num(s._sum.monthly), count: s._count._all }]));
  const itemsBy = new Map<string, ReturnType<typeof toDevice>[]>();
  const push = (contractId: string, d: ReturnType<typeof toDevice>) => itemsBy.set(contractId, [...(itemsBy.get(contractId) ?? []), d]);
  for (const ci of items) push(ci.contractId, toDevice(ci));
  for (const r of returned) push(r.contractId, toReturnedDevice(r));
  const rows = contracts.map((c) => {
    const terms = toTerms(c);
    const devices = itemsBy.get(c.id) ?? [];
    return {
      id: c.id,
      number: c.number,
      partner: c.partner,
      status: c.status,
      startDate: terms.startDate,
      endDate: terms.endDate ?? null,
      billing: c.billing,
      billingMode: c.billingMode,
      seasonFrom: c.seasonFrom,
      seasonTo: c.seasonTo,
      devices: sumBy.get(c.id)?.count ?? 0,
      monthly: sumBy.get(c.id)?.monthly ?? 0,
      nextBilling: c.status === 'ACTIVE' ? nextBillingDate(terms, devices, now) : null,
      pending: activeIds.includes(c.id) ? pendingInstallments(terms, devices, covered.get(c.id) ?? new Set(), now).length : 0,
    };
  });
  return { rows, total, summary: { devices: totals._count, monthly: num(totals._sum.monthly) } };
}

// ---------------------------------------------------------------- kartica ugovora

export async function getContract(companyId: string, id: string) {
  return db.contract.findFirst({
    where: { id, companyId },
    include: {
      partner: { select: { id: true, name: true, city: true, excluded: true } },
      _count: { select: { items: true, invoices: true } },
    },
  });
}

/** Uređaji na ugovoru s podacima za tablicu (bez straničenja — ugovor ima ograničen broj uređaja). */
export async function contractItems(contractId: string) {
  return db.contractItem.findMany({
    where: { contractId },
    orderBy: [{ addedAt: 'asc' }, { item: { serial: 'asc' } }],
    include: {
      item: {
        select: {
          id: true, serial: true, state: true,
          status: { select: { name: true, color: true } },
          model: { select: { brand: true, name: true, category: { select: { name: true } } } },
        },
      },
    },
  });
}

/**
 * Rate za izdati jednog ugovora (i za isključenog partnera) + postojeći nacrti.
 * Uz uređaje na ugovoru gledaju se i skinuti (zaostale rate do dana skidanja).
 */
export async function contractPending(c: Contract, devices: ReturnType<typeof toDevice>[]) {
  const now = today();
  const terms = toTerms(c);
  if (c.status === 'PAUSED' || (c.status !== 'ACTIVE' && !c.closedAt)) return [];
  const [covered, returned] = await Promise.all([
    coveredPeriods(db, [c.id]).then((m) => m.get(c.id) ?? new Set<string>()),
    db.returnedContractItem.findMany({ where: { contractId: c.id, ...returnedWhere(now) } }),
  ]);
  const rows = pendingInstallments(terms, [...devices, ...returned.map(toReturnedDevice)], covered, now);
  const drafts = await draftsFor([c.id]);
  return rows.map((r) => ({
    key: `${c.id}|${r.period}`,
    contractId: c.id,
    contractNumber: c.number,
    partner: null as { id: string; name: string } | null,
    period: r.period,
    dueDate: r.dueDate,
    amount: r.amount,
    itemIds: r.lines.map((l) => l.itemId),
    draftId: drafts.get(`${c.id}|${r.period}`) ?? null,
  }));
}

async function draftsFor(contractIds: string[]) {
  if (!contractIds.length) return new Map<string, string>();
  const drafts = await db.invoice.findMany({
    where: { contractId: { in: contractIds }, status: 'DRAFT', type: 'RENT', kind: 'INVOICE', period: { not: null } },
    select: { id: true, contractId: true, period: true },
    orderBy: { createdAt: 'asc' },
  });
  return new Map(drafts.map((d) => [`${d.contractId}|${d.period}`, d.id]));
}

export type PendingRow = Awaited<ReturnType<typeof contractPending>>[number];

/** Sve rate za izdati u firmi (bez isključenih partnera). */
export async function companyPending(companyId: string): Promise<PendingRow[]> {
  const rows = await pendingForCompany(db, companyId);
  const drafts = await draftsFor([...new Set(rows.map((r) => r.contractId))]);
  return rows.map((r) => ({
    key: `${r.contractId}|${r.period}`,
    contractId: r.contractId,
    contractNumber: r.contractNumber,
    partner: r.partner,
    period: r.period,
    dueDate: r.dueDate,
    amount: r.amount,
    itemIds: r.lines.map((l) => l.itemId),
    draftId: drafts.get(`${r.contractId}|${r.period}`) ?? null,
  }));
}

export async function contractInvoices(companyId: string, contractId: string, page: { skip: number; take: number }) {
  const where: Prisma.InvoiceWhereInput = { companyId, contractId };
  const [total, rows] = await Promise.all([
    db.invoice.count({ where }),
    db.invoice.findMany({
      where,
      orderBy: [{ date: 'desc' }, { seq: 'desc' }],
      skip: page.skip,
      take: page.take,
      select: {
        id: true, number: true, status: true, kind: true, stornoed: true, date: true, dueDate: true, period: true,
        grandTotal: true, paidTotal: true, openAmount: true, paidDate: true,
      },
    }),
  ]);
  return { total, rows };
}

export async function contractHistory(companyId: string, contractId: string) {
  return db.auditLog.findMany({
    where: { companyId, entity: 'contract', entityId: contractId },
    orderBy: { at: 'desc' },
    take: 300,
    select: { id: true, at: true, userName: true, action: true, summary: true },
  });
}

// ---------------------------------------------------------------- dodavanje uređaja

export type CandidateSource = 'stock' | 'partner' | 'all';

const SOURCE_STATES: Record<CandidateSource, StatusKind[]> = {
  stock: ['IN_STOCK', 'RESERVED'],
  partner: ['RENTED'],
  all: ['IN_STOCK', 'RESERVED', 'RENTED', 'OTHER'],
};

/**
 * Uređaji koji se mogu dodati na ugovor (nisu ni na jednom ugovoru), s
 * prijedlogom mjesečnog najma: dogovorena cijena klijenta → uređaj → model → % nabavne.
 */
export async function deviceCandidates(
  companyId: string,
  contractId: string,
  opts: { source?: CandidateSource; q?: string; ids?: string[]; limit?: number },
) {
  const c = await db.contract.findFirst({ where: { id: contractId, companyId }, select: { partnerId: true } });
  if (!c) return [];
  const where: Prisma.ItemWhereInput = { companyId, contractItem: { is: null } };
  if (opts.ids) where.id = { in: opts.ids };
  else {
    const source = opts.source ?? 'stock';
    where.state = { in: SOURCE_STATES[source] };
    if (source === 'partner') where.partnerId = c.partnerId;
    const q = opts.q?.trim();
    if (q) {
      where.OR = [
        { serial: { contains: q, mode: 'insensitive' } },
        { model: { name: { contains: q, mode: 'insensitive' } } },
        { model: { brand: { contains: q, mode: 'insensitive' } } },
        { partner: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }
  }
  const [items, company] = await Promise.all([
    db.item.findMany({
      where,
      orderBy: { serial: 'asc' },
      take: opts.limit ?? 100,
      select: {
        id: true, serial: true, state: true, cost: true, rentPrice: true, modelId: true,
        model: { select: { brand: true, name: true, rentPrice: true } },
        status: { select: { name: true, color: true } },
        partner: { select: { name: true } },
        warehouse: { select: { name: true } },
      },
    }),
    db.company.findUniqueOrThrow({ where: { id: companyId }, select: { rentFallbackPct: true } }),
  ]);
  const agreements = await db.priceAgreement.findMany({
    where: { companyId, partnerId: c.partnerId, modelId: { in: [...new Set(items.map((i) => i.modelId))] } },
    select: { modelId: true, rentPrice: true },
  });
  const agreed = new Map(agreements.map((a) => [a.modelId, a.rentPrice ? num(a.rentPrice) : null]));
  return items.map((i) => {
    const s = suggestedRent({
      agreed: agreed.get(i.modelId),
      itemRent: i.rentPrice ? num(i.rentPrice) : null,
      modelRent: i.model.rentPrice ? num(i.model.rentPrice) : null,
      cost: num(i.cost),
      fallbackPct: num(company.rentFallbackPct),
    });
    return {
      id: i.id,
      serial: i.serial,
      model: [i.model.brand, i.model.name].filter(Boolean).join(' '),
      status: i.status.name,
      color: i.status.color,
      where: i.partner?.name ?? i.warehouse?.name ?? '',
      suggested: s.price,
      source: s.source,
    };
  });
}

export type Candidate = Awaited<ReturnType<typeof deviceCandidates>>[number];
