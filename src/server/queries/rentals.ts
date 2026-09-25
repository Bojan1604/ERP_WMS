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

// popis ugovora je u contract-list.ts (pogledi, obračun/naplata u godini, podnožje)
export { BILLINGS, CONTRACT_STATUSES, contractWhere, listContracts } from './contract-list';

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

/** Bez prava na nabavne cijene prijedlog iz „% nabavne" ne otkriva izvor (C11). */
export const hideCostSource = (rows: Candidate[], canSeeCost: boolean): Candidate[] =>
  canSeeCost ? rows : rows.map((r) => (r.source === 'cost' ? { ...r, source: 'default' as Candidate['source'] } : r));
