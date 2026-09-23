import 'server-only';
import type { Contract, ContractItem, ContractStatus, Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { assert } from '../errors';
import { audit, diff } from '../audit';
import { nextDocNumber } from '../numbering';
import { changeItemStatus, itemEvents, type Actor } from './items';
import { coveredPeriods, createDraft, issueInvoice, markPaid, type LineInput } from './invoices';
import {
  pendingInstallments, installmentDate, planSummary, BILLING_LABEL,
  type BillingCode, type BillingModeCode, type ContractDevice, type ContractTerms, type PendingInstallment, type PlanPeriodInput,
} from '@/domain/billing';
import { formatDate, fromISO, periodLabel, toISO, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { pastPeriods } from '@/domain/plan';
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

// =============================================================================
//  Ugovori — operacije modula Najam
// =============================================================================

export interface ContractTermsInput {
  startDate: string;
  endDate: string | null;
  firstBillingDate: string | null;
  billingDay: number | null;
  billing: BillingCode;
  billingMode: BillingModeCode;
  seasonFrom: number | null;
  seasonTo: number | null;
  note: string | null;
}

function termsData(t: ContractTermsInput) {
  assert(!t.endDate || t.endDate >= t.startDate, 'Kraj ugovora ne može biti prije početka.');
  assert(!t.firstBillingDate || t.firstBillingDate >= t.startDate, 'Prva naplata ne može biti prije početka ugovora.');
  assert(!t.billingDay || (t.billingDay >= 1 && t.billingDay <= 31), 'Dan naplate mora biti između 1 i 31.');
  const seasonal = Boolean(t.seasonFrom || t.seasonTo);
  if (seasonal) {
    assert(t.seasonFrom && t.seasonTo && t.seasonFrom >= 1 && t.seasonFrom <= 12 && t.seasonTo >= 1 && t.seasonTo <= 12, 'Sezona mora imati mjesec od i do.');
  }
  return {
    startDate: fromISO(t.startDate),
    endDate: t.endDate ? fromISO(t.endDate) : null,
    firstBillingDate: t.firstBillingDate ? fromISO(t.firstBillingDate) : null,
    billingDay: t.billingDay || null,
    billing: t.billing,
    billingMode: t.billingMode,
    seasonFrom: seasonal ? t.seasonFrom : null,
    seasonTo: seasonal ? t.seasonTo : null,
    note: t.note,
  };
}

async function ownContract(tx: Tx, actor: Actor, id: string) {
  const c = await tx.contract.findFirst({ where: { id, companyId: actor.companyId }, include: { partner: { select: { id: true, name: true } } } });
  assert(c, 'Ugovor ne postoji.');
  return c;
}

const editable = (s: ContractStatus) => s === 'ACTIVE' || s === 'PAUSED';

export async function createContract(tx: Tx, actor: Actor, input: ContractTermsInput & { partnerId: string }) {
  const partner = await tx.partner.findFirst({ where: { id: input.partnerId, companyId: actor.companyId }, select: { id: true, name: true } });
  assert(partner, 'Klijent ne postoji.');
  const data = termsData(input);
  const number = await nextDocNumber(tx, actor.companyId, 'CONTRACT', Number(input.startDate.slice(0, 4)));
  const c = await tx.contract.create({
    data: { companyId: actor.companyId, number, partnerId: partner.id, status: 'ACTIVE', ...data, createdBy: actor.name },
  });
  await audit(tx, actor, { entity: 'contract', entityId: c.id, action: 'create', summary: `Ugovor ${number} otvoren za ${partner.name}` });
  return c;
}

export async function updateContractTerms(tx: Tx, actor: Actor, id: string, input: ContractTermsInput) {
  const c = await ownContract(tx, actor, id);
  assert(editable(c.status), 'Uvjeti raskinutog ili isteklog ugovora se ne mijenjaju.');
  const data = termsData(input);
  const changes = diff(c as unknown as Record<string, unknown>, data as unknown as Record<string, unknown>);
  await tx.contract.update({ where: { id }, data });
  if (Object.keys(changes).length) {
    await audit(tx, actor, {
      entity: 'contract', entityId: id, action: 'update',
      summary: `Uvjeti ugovora ${c.number} izmijenjeni (${Object.keys(changes).map((k) => TERM_LABEL[k] ?? k).join(', ')})`,
      diff: changes as unknown as Prisma.InputJsonValue,
    });
  }
}

const TERM_LABEL: Record<string, string> = {
  startDate: 'početak', endDate: 'kraj', firstBillingDate: 'prva naplata', billingDay: 'dan naplate',
  billing: 'naplata', billingMode: 'način', seasonFrom: 'sezona od', seasonTo: 'sezona do', note: 'napomena',
};

/** Pauza, nastavak ili istek ugovora. */
export async function setContractStatus(tx: Tx, actor: Actor, id: string, status: 'ACTIVE' | 'PAUSED' | 'EXPIRED') {
  const c = await ownContract(tx, actor, id);
  assert(editable(c.status), 'Raskinut ili istekao ugovor se više ne mijenja.');
  assert(c.status !== status, 'Ugovor je već u tom statusu.');
  await tx.contract.update({ where: { id }, data: { status } });
  const label = { ACTIVE: 'nastavljen', PAUSED: 'pauziran', EXPIRED: 'označen kao istekao' }[status];
  await audit(tx, actor, { entity: 'contract', entityId: id, action: 'status', summary: `Ugovor ${c.number} ${label}` });
}

/**
 * Otkaz: ugovor postaje raskinut s današnjim datumom, rate se više ne traže,
 * izdani računi ostaju. Po želji svi uređaji u najmu odmah idu u povrat
 * („U dolasku") i ostaju na ugovoru dok ih skladište ne zaprimi.
 */
export async function terminateContract(tx: Tx, actor: Actor, id: string, opts: { returnNow: boolean }) {
  const c = await ownContract(tx, actor, id);
  assert(editable(c.status), 'Ugovor je već raskinut ili istekao.');
  const t = today();
  const end = c.endDate && toISO(c.endDate) < t ? c.endDate : fromISO(t);
  await tx.contract.update({ where: { id }, data: { status: 'TERMINATED', terminatedAt: fromISO(t), endDate: end } });
  let returned = 0;
  if (opts.returnNow) {
    const rented = await tx.contractItem.findMany({ where: { contractId: id, item: { state: 'RENTED' } }, select: { itemId: true } });
    const res = await changeItemStatus(tx, actor, rented.map((r) => r.itemId), {
      kind: 'RETURNING',
      event: { type: 'RETURNING', message: `Najavljen povrat — ugovor ${c.number} otkazan`, refType: 'contract', refId: id },
    });
    returned = res.count;
  }
  await audit(tx, actor, {
    entity: 'contract', entityId: id, action: 'terminate',
    summary: `Ugovor ${c.number} otkazan ${formatDate(t)}${returned ? ` — ${returned} uređaja najavljeno za povrat` : ''}`,
  });
  return { returned };
}

async function ownItems(tx: Tx, contractId: string, ids: string[]) {
  const rows = await tx.contractItem.findMany({
    where: { contractId, id: { in: ids } },
    select: { id: true, itemId: true, monthly: true, status: true, item: { select: { serial: true, state: true } } },
  });
  assert(rows.length === new Set(ids).size, 'Neki uređaji nisu na ovom ugovoru.');
  return rows;
}

const serials = (rows: Array<{ item: { serial: string } }>) => {
  const s = rows.map((r) => r.item.serial);
  return s.length > 6 ? `${s.slice(0, 6).join(', ')} i još ${s.length - 6}` : s.join(', ');
};

/** Grupna izmjena uređaja na ugovoru: mjesečna cijena, plan naplate ili pauza. */
export async function updateContractItems(
  tx: Tx,
  actor: Actor,
  contractId: string,
  ids: string[],
  patch: { monthly?: number; plan?: PlanPeriodInput[]; status?: 'PAUSED' | null },
) {
  const c = await ownContract(tx, actor, contractId);
  assert(editable(c.status), 'Uređaji raskinutog ili isteklog ugovora se ne mijenjaju.');
  const rows = await ownItems(tx, contractId, ids);
  const data: Prisma.ContractItemUpdateManyMutationInput = {};
  const what: string[] = [];
  if (patch.monthly !== undefined) {
    assert(patch.monthly >= 0, 'Mjesečna cijena ne može biti negativna.');
    data.monthly = r2(patch.monthly);
    what.push(`mjesečna cijena ${r2(patch.monthly).toFixed(2).replace('.', ',')} €`);
  }
  if (patch.plan !== undefined) {
    data.plan = patch.plan as unknown as Prisma.InputJsonValue;
    what.push(patch.plan.length ? `plan naplate: ${planSummary(toTerms(c), { itemId: '', monthly: 0, plan: patch.plan })}` : 'plan naplate prati ugovor');
  }
  if (patch.status !== undefined) {
    data.status = patch.status;
    what.push(patch.status === 'PAUSED' ? 'pauzirano' : 'nastavljeno');
  }
  assert(what.length, 'Nema promjene.');
  await tx.contractItem.updateMany({ where: { contractId, id: { in: ids } }, data });
  await itemEvents(tx, actor, rows.map((r) => r.itemId), { type: 'CONTRACT', message: `Ugovor ${c.number}: ${what.join(', ')}`, refType: 'contract', refId: contractId });
  await audit(tx, actor, {
    entity: 'contract', entityId: contractId, action: 'items',
    summary: `${rows.length} uređaja (${serials(rows)}): ${what.join(', ')}`,
  });
}

/**
 * „Ukloni s ugovora": uređaj je još kod klijenta, pa ide u povrat („U dolasku")
 * i ostaje na ugovoru dok ga skladište ne zaprimi.
 */
export async function removeFromContract(tx: Tx, actor: Actor, contractId: string, ids: string[]) {
  const c = await ownContract(tx, actor, contractId);
  const rows = await ownItems(tx, contractId, ids);
  const rented = rows.filter((r) => r.item.state === 'RENTED');
  assert(rented.length, 'Označeni uređaji su već najavljeni za povrat.');
  await changeItemStatus(tx, actor, rented.map((r) => r.itemId), {
    kind: 'RETURNING',
    event: { type: 'RETURNING', message: `Najavljen povrat — uklonjen s ugovora ${c.number}`, refType: 'contract', refId: contractId },
  });
  await audit(tx, actor, { entity: 'contract', entityId: contractId, action: 'remove', summary: `Najavljen povrat ${rented.length} uređaja: ${serials(rented)}` });
  return rented.length;
}

/**
 * Dodavanje uređaja (jedna skupina s istim uvjetima). `skipPast` popunjava
 * preskočena razdoblja onima čija je rata već prošla — računi za njih
 * izdani su izvan programa.
 */
export async function addDevices(
  tx: Tx,
  actor: Actor,
  contractId: string,
  rows: Array<{ itemId: string; monthly: number; plan: PlanPeriodInput[] }>,
  opts: { skipPast: boolean },
) {
  const c = await ownContract(tx, actor, contractId);
  assert(rows.length, 'Odaberite barem jedan uređaj.');
  assert(rows.every((r) => r.monthly >= 0), 'Mjesečna cijena ne može biti negativna.');
  const terms = toTerms(c);
  const now = today();
  const withSkipped = rows.map((r) => ({
    ...r,
    monthly: r2(r.monthly),
    skipped: opts.skipPast ? pastPeriods(terms, { itemId: r.itemId, monthly: r.monthly, plan: r.plan }, now) : [],
  }));
  await attachItems(tx, actor, contractId, withSkipped);
  const items = await tx.item.findMany({ where: { id: { in: rows.map((r) => r.itemId) } }, select: { serial: true } });
  const skippedCount = withSkipped.reduce((a, r) => a + r.skipped.length, 0);
  await audit(tx, actor, {
    entity: 'contract', entityId: contractId, action: 'add',
    summary:
      `Dodano ${rows.length} uređaja: ${serials(items.map((i) => ({ item: i })))}` +
      (rows.some((r) => r.plan.length) ? ' — s vlastitim planom naplate' : '') +
      (skippedCount ? ` — prošla razdoblja označena kao izdana (${skippedCount})` : ''),
  });
  return { count: rows.length, skipped: skippedCount };
}

/** Ručni iznos u mreži najma; null briše ručni upis. */
export async function setRentOverride(tx: Tx, actor: Actor, input: { itemId: string; year: number; month: number; amount: number | null }) {
  const item = await tx.item.findFirst({ where: { id: input.itemId, companyId: actor.companyId }, select: { id: true, serial: true } });
  assert(item, 'Uređaj ne postoji.');
  assert(input.month >= 1 && input.month <= 12, 'Neispravan mjesec.');
  const key = { itemId_year_month: { itemId: item.id, year: input.year, month: input.month } };
  const label = `${String(input.month).padStart(2, '0')}/${input.year}`;
  if (input.amount === null) {
    await tx.rentOverride.deleteMany({ where: { itemId: item.id, year: input.year, month: input.month } });
    await audit(tx, actor, { entity: 'item', entityId: item.id, action: 'rent-override', summary: `SN ${item.serial}: ručni iznos najma za ${label} uklonjen` });
    return;
  }
  const amount = r2(input.amount);
  await tx.rentOverride.upsert({
    where: key,
    create: { companyId: actor.companyId, itemId: item.id, year: input.year, month: input.month, amount },
    update: { amount },
  });
  await audit(tx, actor, { entity: 'item', entityId: item.id, action: 'rent-override', summary: `SN ${item.serial}: ručni iznos najma za ${label} = ${amount.toFixed(2).replace('.', ',')} €` });
}

/** Postojeći nacrt za ratu (npr. otvoren preko „Pregledaj") ili novi. */
async function draftFor(tx: Tx, actor: Actor, contractId: string, period: string) {
  const existing = await tx.invoice.findFirst({
    where: { companyId: actor.companyId, contractId, period, status: 'DRAFT', type: 'RENT', kind: 'INVOICE' },
    orderBy: { createdAt: 'desc' },
  });
  return existing ?? (await draftInstallment(tx, actor, contractId, period));
}

/** „Pregledaj": nacrt rate koji se uređuje u Prodaji — postojeći se ponovno koristi. */
export async function previewInstallment(tx: Tx, actor: Actor, contractId: string, period: string) {
  const c = await ownContract(tx, actor, contractId);
  const d = await draftFor(tx, actor, contractId, period);
  await audit(tx, actor, { entity: 'contract', entityId: c.id, action: 'draft', summary: `Nacrt računa za ${periodLabel(period)}` });
  return d.id;
}

/**
 * Izdavanje označenih rata u jednoj transakciji (kao `issueInstallments`, ali
 * postojeći nacrti rate se izdaju umjesto da nastane još jedan račun).
 */
export async function issuePending(tx: Tx, actor: Actor, rows: Array<{ contractId: string; period: string }>, opts: { paid?: boolean } = {}) {
  assert(rows.length, 'Odaberite barem jednu ratu.');
  const drafts = [];
  for (const r of rows) {
    await ownContract(tx, actor, r.contractId);
    drafts.push(await draftFor(tx, actor, r.contractId, r.period));
  }
  drafts.sort((a, b) => a.date.getTime() - b.date.getTime());
  const numbers: string[] = [];
  for (const d of drafts) {
    const { number } = await issueInvoice(tx, actor, d.id);
    numbers.push(number);
    if (opts.paid) await markPaid(tx, actor, d.id, toISO(d.date));
    await audit(tx, actor, {
      entity: 'contract', entityId: d.contractId, action: 'issue',
      summary: `Izdan račun ${number} za ${periodLabel(d.period ?? '')}${opts.paid ? ' — plaćeno' : ''}`,
    });
  }
  return numbers;
}

/** „Ne izdaji — već izdano" za uređaje rate, uz zapis u dnevnik. */
export async function skipPending(tx: Tx, actor: Actor, contractId: string, period: string, itemIds: string[]) {
  const c = await ownContract(tx, actor, contractId);
  await skipInstallment(tx, actor, contractId, period, itemIds);
  await audit(tx, actor, {
    entity: 'contract', entityId: c.id, action: 'skip',
    summary: `Rata za ${periodLabel(period)} označena kao izdana izvan programa (${itemIds.length} uređaja)`,
  });
}
