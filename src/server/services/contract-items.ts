import 'server-only';
import type { Contract, ContractItem, Prisma, ReturnedContractItem } from '@prisma/client';
import type { Tx } from '../db';
import { periodsInPause, type ContractDevice, type ContractTerms, type PlanPeriodInput } from '@/domain/billing';
import { fromISO, toISO } from '@/domain/dates';
import { num } from '@/domain/money';

/**
 * Uređaji ugovora za motor naplate — bez ovisnosti o drugim servisima, pa ga
 * koriste i `items.ts` (skidanje s ugovora) i `rentals.ts`/`invoices.ts`.
 */

/** Ugovor iz baze → uvjeti za motor naplate. */
export function toTerms(c: Contract): ContractTerms {
  return {
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
  };
}

export function toDevice(ci: ContractItem): ContractDevice {
  return {
    itemId: ci.itemId,
    monthly: num(ci.monthly),
    plan: (ci.plan as unknown as PlanPeriodInput[]) ?? [],
    status: ci.status,
    skipped: ci.skipped,
    paused: ci.paused,
  };
}

/** Uređaj skinut s ugovora: isti uvjeti, naplata do datuma skidanja. */
export function toReturnedDevice(r: ReturnedContractItem): ContractDevice {
  return {
    itemId: r.itemId,
    monthly: num(r.monthly),
    plan: (r.plan as unknown as PlanPeriodInput[]) ?? [],
    status: null,
    skipped: r.skipped,
    paused: r.paused,
    endDate: toISO(r.endDate),
  };
}

/**
 * Što je već fakturirano po ugovoru: ključevi `itemId|YYYY-MM` iz izdanih,
 * nestorniranih računa za najam.
 */
export async function coveredPeriods(tx: Tx, contractIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!contractIds.length) return out;
  const lines = await tx.invoiceLine.findMany({
    where: {
      itemId: { not: null },
      invoice: { contractId: { in: contractIds }, status: 'ISSUED', kind: 'INVOICE', stornoed: false, type: 'RENT' },
    },
    select: { itemId: true, invoice: { select: { contractId: true, period: true, date: true } } },
  });
  for (const l of lines) {
    const cid = l.invoice.contractId!;
    const p = l.invoice.period || toISO(l.invoice.date).slice(0, 7);
    if (!out.has(cid)) out.set(cid, new Set());
    out.get(cid)!.add(`${l.itemId}|${p}`);
  }
  return out;
}

/**
 * Uređaj se vraća na isti ugovor (povrat iz servisa ili zamjenski uređaj na
 * njegovo mjesto): snimke skidanja s tog ugovora od `since` se brišu, a njihova
 * preskočena i pauzirana razdoblja prelaze u novi redak — naplata se nastavlja
 * na jednom retku i svako razdoblje se traži samo jednom.
 */
export async function takeBackReturned(tx: Tx, contractId: string, itemId: string, since: Date) {
  const from = fromISO(toISO(since));
  const rows = await tx.returnedContractItem.findMany({ where: { contractId, itemId, endDate: { gte: from } } });
  if (rows.length) await tx.returnedContractItem.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  return { skipped: rows.flatMap((r) => r.skipped), paused: rows.flatMap((r) => r.paused) };
}

const merge = (...lists: Array<string[] | null | undefined>) => [...new Set(lists.flatMap((l) => l ?? []))].sort();
export { merge as mergePeriods };

export interface PauseRow {
  id: string;
  /** Redak iz `ReturnedContractItem` (uređaj skinut s ugovora). */
  returned: boolean;
  device: ContractDevice;
  /** Početak pauze (YYYY-MM-DD). */
  since: string;
}

/**
 * Kraj pauze: rate dospjele u pauzi [since, until) upisuju se u pauzirana
 * razdoblja uređaja, osim već fakturiranih i preskočenih. Vraća broj upisanih.
 */
export async function addPausedPeriods(tx: Tx, c: Contract, rows: PauseRow[], until: string) {
  if (!rows.length) return 0;
  const covered = (await coveredPeriods(tx, [c.id])).get(c.id) ?? new Set<string>();
  const terms = toTerms(c);
  let n = 0;
  for (const r of rows) {
    const have = new Set([...(r.device.paused ?? []), ...(r.device.skipped ?? [])]);
    const add = periodsInPause(terms, r.device, r.since, until).filter((p) => !have.has(p) && !covered.has(`${r.device.itemId}|${p}`));
    if (!add.length) continue;
    const paused = [...(r.device.paused ?? []), ...add].sort();
    if (r.returned) await tx.returnedContractItem.update({ where: { id: r.id }, data: { paused } });
    else await tx.contractItem.update({ where: { id: r.id }, data: { paused } });
    n += add.length;
  }
  return n;
}

/**
 * Uređaj se skida s ugovora (povrat na skladište, prodaja, servis…): uvjeti se
 * čuvaju u `ReturnedContractItem` s datumom skidanja, pa rate do tog dana koje
 * još nisu izdane ostaju u „Rate za izdati". Pauza uređaja se zaključuje do tog dana.
 */
export async function keepReturned(tx: Tx, rows: ContractItem[], endDate: string) {
  if (!rows.length) return;
  const contracts = await tx.contract.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.contractId))] } } });
  const byId = new Map(contracts.map((c) => [c.id, c]));
  const covered = await coveredPeriods(tx, contracts.map((c) => c.id));
  const data: Prisma.ReturnedContractItemCreateManyInput[] = [];
  for (const ci of rows) {
    const c = byId.get(ci.contractId);
    if (!c) continue;
    // zatvoreni uvezeni ugovor ne traži rate; raskinut uređaj ili stara pauza bez početka — također ne
    if ((c.status === 'TERMINATED' || c.status === 'EXPIRED') && !c.closedAt) continue;
    if (ci.status === 'TERMINATED' || (ci.status === 'PAUSED' && !ci.pausedSince)) continue;
    const d = toDevice(ci);
    let paused = ci.paused;
    if (ci.status === 'PAUSED' && ci.pausedSince) {
      const have = new Set([...ci.paused, ...ci.skipped]);
      const cov = covered.get(c.id) ?? new Set<string>();
      const add = periodsInPause(toTerms(c), d, toISO(ci.pausedSince), endDate).filter((p) => !have.has(p) && !cov.has(`${ci.itemId}|${p}`));
      paused = [...paused, ...add].sort();
    }
    data.push({
      contractId: ci.contractId,
      itemId: ci.itemId,
      monthly: ci.monthly,
      plan: ci.plan as Prisma.InputJsonValue,
      skipped: ci.skipped,
      paused,
      endDate: fromISO(endDate),
    });
  }
  if (data.length) await tx.returnedContractItem.createMany({ data });
}
