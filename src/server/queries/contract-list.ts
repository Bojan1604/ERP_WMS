import 'server-only';
import type { ContractStatus, Prisma } from '@prisma/client';
import { db } from '../db';
import { coveredPeriods } from '../services/invoices';
import { attachmentCounts } from '../services/attachments';
import { returnedWhere, toDevice, toReturnedDevice, toTerms } from '../services/rentals';
import {
  BILLING_MONTHS, contractAccrual, contractBilling, hasCustomPlan, nextBillingDate, pendingInstallments,
  type BillingCode, type ContractDevice, type ContractStatusCode, type ContractTerms, type PlanPeriodInput,
} from '@/domain/billing';
import { addDays, daysBetween, fromISO, toISO, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { paramStr, parseMulti, parseSort, sortOrderBy } from '@/lib/list-params';

type Params = Record<string, string | string[] | undefined>;

export const CONTRACT_STATUSES: ContractStatusCode[] = ['ACTIVE', 'PAUSED', 'EXPIRED', 'TERMINATED'];
export const BILLINGS: BillingCode[] = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ONCE'];

/** Pogledi popisa ugovora (C2): aktivni (zadano), sezonski, uskoro istječu (< 120 dana), svi. */
export const CONTRACT_VIEWS = ['', 'sezonski', 'istek', 'svi'] as const;
export type ContractView = (typeof CONTRACT_VIEWS)[number];
/** „Uskoro istječe": kraj ugovora unutar ovoliko dana. */
export const EXPIRING_DAYS = 120;

export const CONTRACT_SORTS = ['broj', 'klijent', 'pocetak', 'kraj'] as const;

/** Filtri popisa ugovora iz URL-a → Prisma where (sve u bazi). */
export function contractWhere(companyId: string, params: Params): Prisma.ContractWhereInput {
  const and: Prisma.ContractWhereInput[] = [{ companyId }];
  const q = paramStr(params, 'q');
  const statuses = parseMulti(params, 'status', CONTRACT_STATUSES);
  const partners = parseMulti(params, 'partner');
  const billings = parseMulti(params, 'billing', BILLINGS);
  const view = paramStr(params, 'pogled');
  const now = today();
  if (q) and.push({ OR: [{ number: { contains: q, mode: 'insensitive' } }, { partner: { name: { contains: q, mode: 'insensitive' } } }] });
  if (statuses.length) and.push({ status: { in: statuses as ContractStatus[] } });
  // zadani pogled „Aktivni" — osim kad je status izričito odabran
  else if (view === '') and.push({ status: 'ACTIVE' });
  if (view === 'sezonski') and.push({ seasonFrom: { not: null } });
  // uskoro istječu: samo ugovori koji još teku (istekli i raskinuti imaju kraj = dan zatvaranja)
  if (view === 'istek') and.push({ endDate: { gte: fromISO(now), lt: fromISO(addDays(now, EXPIRING_DAYS)) }, ...(statuses.length ? {} : { status: { in: ['ACTIVE', 'PAUSED'] } }) });
  if (partners.length) and.push({ partnerId: { in: partners } });
  if (billings.length) and.push({ billing: { in: billings } });
  // isključeni partneri skriveni su, osim kad se izričito traže (ili se filtrira baš po njima)
  if (paramStr(params, 'iskljuceni') !== '1' && !partners.length) and.push({ partner: { excluded: false } });
  return { AND: and };
}

type TermsRow = Pick<
  Prisma.ContractGetPayload<object>,
  'id' | 'status' | 'startDate' | 'endDate' | 'firstBillingDate' | 'billingDay' | 'billing' | 'billingMode' | 'seasonFrom' | 'seasonTo' | 'closedAt'
>;

const termsOf = (c: TermsRow): ContractTerms => ({
  status: c.status,
  startDate: toISO(c.startDate),
  endDate: c.endDate ? toISO(c.endDate) : null,
  firstBillingDate: c.firstBillingDate ? toISO(c.firstBillingDate) : null,
  billingDay: c.billingDay,
  billing: c.billing,
  billingMode: c.billingMode,
  seasonFrom: c.seasonFrom,
  seasonTo: c.seasonTo,
  closedAt: c.closedAt ? toISO(c.closedAt) : null,
});

export interface ContractYear {
  accrual: number;
  billing: number;
  monthly: number;
  devices: number;
  custom: number;
}

/** Skupina istih uređaja ugovora (ista cijena, plan, status, pauze; skinuti i isti kraj) iz baze. */
interface DeviceGroup {
  contractId: string;
  monthly: string;
  plan: string;
  status: ContractStatus | null;
  paused: string[];
  endDate: Date | null;
  returned: boolean;
  n: number;
}

/**
 * Obračun i naplata u godini za sve ugovore filtra (za stupce i podnožje): uvjeti
 * ugovora, pa uređaji grupirani u bazi po (ugovor, cijena, plan, status, pauze) —
 * veliki ugovori s tisućama istih uređaja ne učitavaju se redak po redak. Skinuti
 * uređaji (naplata do dana skidanja) ulaze u obračun i naplatu, ne u broj uređaja.
 */
async function yearStats(where: Prisma.ContractWhereInput, year: number) {
  const contracts = await db.contract.findMany({
    where,
    select: {
      id: true, status: true, startDate: true, endDate: true, firstBillingDate: true, billingDay: true, billing: true, billingMode: true,
      seasonFrom: true, seasonTo: true, closedAt: true,
    },
  });
  const ids = contracts.map((c) => c.id);
  const groups = ids.length
    ? await db.$queryRaw<DeviceGroup[]>`
        SELECT "contractId", monthly::text AS monthly, plan::text AS plan, status, paused, NULL::date AS "endDate", false AS returned, count(*)::int AS n
        FROM "ContractItem" WHERE "contractId" = ANY(${ids}::text[])
        GROUP BY "contractId", monthly, plan::text, status, paused
        UNION ALL
        SELECT "contractId", monthly::text, plan::text, NULL, paused, "endDate", true, count(*)::int
        FROM "ReturnedContractItem" WHERE "contractId" = ANY(${ids}::text[]) AND "endDate" >= ${fromISO(`${year}-01-01`)}
        GROUP BY "contractId", monthly, plan::text, paused, "endDate"`
    : [];
  const terms = new Map(contracts.map((c) => [c.id, termsOf(c)]));
  const out = new Map<string, ContractYear>(contracts.map((c) => [c.id, { accrual: 0, billing: 0, monthly: 0, devices: 0, custom: 0 }]));
  for (const g of groups) {
    const t = terms.get(g.contractId);
    const s = out.get(g.contractId);
    if (!t || !s) continue;
    const d: ContractDevice = {
      itemId: '',
      monthly: num(g.monthly),
      plan: (JSON.parse(g.plan) as PlanPeriodInput[]) ?? [],
      status: g.status,
      paused: g.paused,
      endDate: g.endDate ? toISO(g.endDate) : null,
    };
    s.accrual += contractAccrual(t, [d], year).reduce((a, b) => a + b, 0) * g.n;
    s.billing += contractBilling(t, [d], year).reduce((a, b) => a + b, 0) * g.n;
    if (g.returned) continue;
    s.monthly += d.monthly * g.n;
    s.devices += g.n;
    if (hasCustomPlan(d)) s.custom += g.n;
  }
  for (const s of out.values()) {
    s.accrual = r2(s.accrual);
    s.billing = r2(s.billing);
    s.monthly = r2(s.monthly);
  }
  return { contracts, stats: out };
}

/**
 * Stranica popisa ugovora: redci s mjesečnim iznosom, ratom, obračunom i naplatom
 * u godini, danima do isteka i oznakom priloženog PDF-a; sljedeća naplata i broj
 * rata za izdati motorom naplate — samo za ugovore na ovoj stranici. Podnožje je
 * za cijeli filtar.
 */
export async function listContracts(companyId: string, params: Params, page: { skip: number; take: number }) {
  const where = contractWhere(companyId, params);
  const now = today();
  const year = Number(now.slice(0, 4));
  const sort = parseSort(params, CONTRACT_SORTS, null);
  const orderBy =
    sortOrderBy<(typeof CONTRACT_SORTS)[number], Prisma.ContractOrderByWithRelationInput>(
      sort,
      {
        broj: (d) => ({ number: d }),
        klijent: (d) => ({ partner: { name: d } }),
        pocetak: (d) => ({ startDate: d }),
        kraj: (d) => ({ endDate: { sort: d, nulls: 'last' } }),
      },
      { id: 'asc' },
    ) ?? [];
  const [total, contracts, { contracts: all, stats }] = await Promise.all([
    db.contract.count({ where }),
    db.contract.findMany({
      where,
      orderBy: sort ? orderBy : [{ startDate: 'desc' }, { number: 'desc' }],
      skip: page.skip,
      take: page.take,
      include: { partner: { select: { id: true, name: true, excluded: true } } },
    }),
    yearStats(where, year),
  ]);
  const ids = contracts.map((c) => c.id);
  // rate za izdati imaju aktivni ugovori, pauzirani (rate prije pauze) i oni zatvoreni u programu (zaostale rate)
  const activeIds = contracts.filter((c) => c.status === 'ACTIVE' || (c.status === 'PAUSED' ? c.pausedSince : c.closedAt)).map((c) => c.id);
  const [items, returned, covered, pdf] = await Promise.all([
    db.contractItem.findMany({ where: { contractId: { in: activeIds } } }),
    db.returnedContractItem.findMany({ where: { contractId: { in: activeIds }, ...returnedWhere(now) } }),
    coveredPeriods(db, activeIds),
    attachmentCounts(db, companyId, 'contract', ids),
  ]);
  const itemsBy = new Map<string, ContractDevice[]>();
  const push = (contractId: string, d: ContractDevice) => {
    const list = itemsBy.get(contractId);
    if (list) list.push(d);
    else itemsBy.set(contractId, [d]);
  };
  for (const ci of items) push(ci.contractId, toDevice(ci));
  for (const r of returned) push(r.contractId, toReturnedDevice(r));
  const rows = contracts.map((c) => {
    const terms = toTerms(c);
    const devices = itemsBy.get(c.id) ?? [];
    const s = stats.get(c.id) ?? { accrual: 0, billing: 0, monthly: 0, devices: 0, custom: 0 };
    const months = BILLING_MONTHS[c.billing] ?? 1;
    return {
      id: c.id,
      number: c.number,
      partner: c.partner,
      status: c.status,
      startDate: terms.startDate,
      endDate: terms.endDate ?? null,
      endsIn: terms.endDate ? daysBetween(now, terms.endDate) : null,
      billing: c.billing,
      billingMode: c.billingMode,
      seasonFrom: c.seasonFrom,
      seasonTo: c.seasonTo,
      devices: s.devices,
      monthly: s.monthly,
      /** Uređaji s vlastitim uvjetima (plan ili status) — tada rata nije jedinstvena. */
      custom: s.custom,
      installment: s.custom || !months ? null : r2(s.monthly * months),
      accrual: s.accrual,
      billed: s.billing,
      pdf: pdf.get(c.id) ?? 0,
      nextBilling: c.status === 'ACTIVE' ? nextBillingDate(terms, devices, now, covered.get(c.id)) : null,
      pending: activeIds.includes(c.id) ? pendingInstallments(terms, devices, covered.get(c.id) ?? new Set(), now).length : 0,
    };
  });
  // podnožje za cijeli filtar
  const expiring = (e: Date | null) => {
    if (!e) return false;
    const n = daysBetween(now, toISO(e));
    return n >= 0 && n < EXPIRING_DAYS;
  };
  // monthly = aktivni ugovori (sažetak), monthlyAll = zbroj stupca „Mjesečno" za sve ugovore filtra
  const summary = { devices: 0, monthly: 0, monthlyAll: 0, accrual: 0, billed: 0, custom: 0, seasonal: 0, expiring: 0, year };
  for (const c of all) {
    const s = stats.get(c.id)!;
    summary.devices += s.devices;
    if (c.status === 'ACTIVE') summary.monthly += s.monthly;
    summary.monthlyAll += s.monthly;
    summary.accrual += s.accrual;
    summary.billed += s.billing;
    summary.custom += s.custom;
    if (c.seasonFrom) summary.seasonal += 1;
    if ((c.status === 'ACTIVE' || c.status === 'PAUSED') && expiring(c.endDate)) summary.expiring += 1;
  }
  summary.monthly = r2(summary.monthly);
  summary.monthlyAll = r2(summary.monthlyAll);
  summary.accrual = r2(summary.accrual);
  summary.billed = r2(summary.billed);
  return { rows, total, summary };
}

export type ContractListRow = Awaited<ReturnType<typeof listContracts>>['rows'][number];
