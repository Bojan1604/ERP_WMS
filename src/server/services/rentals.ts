import 'server-only';
import type { Contract, ContractItem } from '@prisma/client';
import type { Tx } from '../db';
import { assert } from '../errors';
import { changeItemStatus, type Actor } from './items';
import { coveredPeriods, createDraft, issueInvoice, markPaid, type LineInput } from './invoices';
import {
  pendingInstallments, installmentDate, BILLING_LABEL,
  type ContractDevice, type ContractTerms, type PendingInstallment, type PlanPeriodInput,
} from '@/domain/billing';
import { periodLabel, toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { customerVat } from '@/domain/tax';

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
  };
}

export function toDevice(ci: ContractItem): ContractDevice {
  return {
    itemId: ci.itemId,
    monthly: num(ci.monthly),
    plan: (ci.plan as unknown as PlanPeriodInput[]) ?? [],
    status: ci.status,
    skipped: ci.skipped,
  };
}

/** Uređaji idu na ugovor: status „U najmu", kupac i datum izdavanja. */
export async function attachItems(
  tx: Tx,
  actor: Actor,
  contractId: string,
  rows: Array<{ itemId: string; monthly: number; plan?: PlanPeriodInput[]; skipped?: string[] }>,
  opts: { issueDate?: string } = {},
) {
  const c = await tx.contract.findFirst({ where: { id: contractId, companyId: actor.companyId }, include: { partner: true } });
  assert(c, 'Ugovor ne postoji.');
  assert(c.status === 'ACTIVE' || c.status === 'PAUSED', 'Na raskinut ili istekao ugovor ne mogu se dodavati uređaji.');
  const ids = rows.map((r) => r.itemId);
  const items = await tx.item.findMany({
    where: { id: { in: ids }, companyId: actor.companyId },
    select: { id: true, serial: true, state: true, partnerId: true, contractItem: { select: { contractId: true } } },
  });
  assert(items.length === ids.length, 'Neki uređaji ne postoje.');
  const taken = items.filter((i) => i.contractItem);
  assert(!taken.length, `Uređaji su već na ugovoru: ${taken.map((i) => i.serial).join(', ')}`);
  const bad = items.filter((i) => !['IN_STOCK', 'RESERVED', 'RENTED', 'OTHER'].includes(i.state));
  assert(!bad.length, `Uređaji nisu raspoloživi za najam: ${bad.map((i) => i.serial).join(', ')}`);

  await tx.contractItem.createMany({
    data: rows.map((r) => ({
      contractId,
      itemId: r.itemId,
      monthly: r.monthly,
      plan: (r.plan ?? []) as object,
      skipped: r.skipped ?? [],
    })),
  });
  const date = opts.issueDate ?? today();
  await changeItemStatus(tx, actor, ids, {
    kind: 'RENTED',
    data: { partnerId: c.partnerId, issueDate: new Date(`${date}T00:00:00Z`), warrantyStart: new Date(`${date}T00:00:00Z`), warehouseId: null },
    event: { type: 'RENTED', message: `U najmu — ugovor ${c.number} (${c.partner.name})`, refType: 'contract', refId: contractId },
  });
}

/** Rate za izdati po ugovorima firme (ili jednom ugovoru). */
export async function pendingForCompany(tx: Tx, companyId: string, opts: { contractId?: string; now?: string } = {}) {
  const contracts = await tx.contract.findMany({
    where: { companyId, status: 'ACTIVE', ...(opts.contractId ? { id: opts.contractId } : {}), partner: { excluded: false } },
    include: { items: true, partner: { select: { id: true, name: true } } },
  });
  const covered = await coveredPeriods(tx, contracts.map((c) => c.id));
  const out: Array<PendingInstallment & { contractId: string; contractNumber: string; partner: { id: string; name: string } }> = [];
  for (const c of contracts) {
    const rows = pendingInstallments(toTerms(c), c.items.map(toDevice), covered.get(c.id) ?? new Set(), opts.now ?? today());
    for (const r of rows) out.push({ ...r, contractId: c.id, contractNumber: c.number, partner: c.partner });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.contractNumber.localeCompare(b.contractNumber));
}

/**
 * Nacrt računa za ratu: stavke su uređaji koji su tog razdoblja u naplati,
 * svaki s mjesečnom cijenom × brojem mjeseci naplate.
 */
export async function draftInstallment(tx: Tx, actor: Actor, contractId: string, period: string) {
  const c = await tx.contract.findFirst({
    where: { id: contractId, companyId: actor.companyId },
    include: { partner: true, company: true, items: { include: { item: { include: { model: true } } } } },
  });
  assert(c, 'Ugovor ne postoji.');
  const covered = (await coveredPeriods(tx, [c.id])).get(c.id) ?? new Set();
  const terms = toTerms(c);
  const pending = pendingInstallments(terms, c.items.map(toDevice), covered, installmentDate(terms, period), 1200).find((p) => p.period === period);
  assert(pending, `Za razdoblje ${period} nema rate za izdati.`);

  const byItem = new Map(c.items.map((ci) => [ci.itemId, ci.item]));
  const lines: LineInput[] = pending.lines.map((l) => {
    const item = byItem.get(l.itemId)!;
    const name = [item.model.brand, item.model.name].filter(Boolean).join(' ');
    const months = l.billing === 'ONCE' ? l.months : l.months;
    return {
      kind: 'DEVICE',
      itemId: l.itemId,
      modelId: item.modelId,
      description: `Najam ${name}, SN ${item.serial} — ${BILLING_LABEL[l.billing].toLowerCase()}`,
      unit: 'mj',
      kpd: item.model.kpd,
      qty: 1,
      monthly: l.monthly,
      months,
      unitPrice: l.amount,
    };
  });
  const vat = customerVat(c.partner.country, { vatRegistered: c.company.vatRegistered, vatRate: num(c.company.vatRate), country: c.company.country });
  // datum rate, ali ne raniji od zadnjeg izdanog računa (redni broj prati datum) ni kasniji od danas
  let date = installmentDate(toTerms(c), period);
  if (date > today()) date = today();
  const last = await tx.invoice.findFirst({
    where: { companyId: actor.companyId, status: 'ISSUED', year: Number(date.slice(0, 4)) },
    orderBy: { date: 'desc' },
    select: { date: true },
  });
  if (last && toISO(last.date) > date) date = toISO(last.date);
  return createDraft(tx, actor, {
    type: 'RENT',
    partnerId: c.partnerId,
    date,
    vatRate: vat.rate,
    taxCategory: vat.category,
    taxExemptReason: vat.exemptReason ?? null,
    contractId: c.id,
    period,
    description: `Najam za ${periodLabel(period)} — ugovor ${c.number}`,
    lines,
  });
}

/** Izdavanje jedne ili više rata odjednom (u jednoj transakciji), po želji odmah plaćeno. */
export async function issueInstallments(tx: Tx, actor: Actor, rows: Array<{ contractId: string; period: string }>, opts: { paid?: boolean } = {}) {
  // datum mora pratiti redni broj — izdaje se kronološki
  const drafts = [];
  for (const r of rows) drafts.push(await draftInstallment(tx, actor, r.contractId, r.period));
  drafts.sort((a, b) => a.date.getTime() - b.date.getTime());
  const numbers: string[] = [];
  for (const d of drafts) {
    const { number } = await issueInvoice(tx, actor, d.id);
    numbers.push(number);
    if (opts.paid) await markPaid(tx, actor, d.id, toISO(d.date));
  }
  return numbers;
}

/** Razdoblje se trajno označava kao izdano izvan programa — ne traži račun. */
export async function skipInstallment(tx: Tx, actor: Actor, contractId: string, period: string, itemIds: string[]) {
  const rows = await tx.contractItem.findMany({ where: { contractId, itemId: { in: itemIds }, contract: { companyId: actor.companyId } } });
  for (const r of rows) {
    if (!r.skipped.includes(period)) await tx.contractItem.update({ where: { id: r.id }, data: { skipped: [...r.skipped, period] } });
  }
}
