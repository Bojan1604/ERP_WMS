import 'server-only';
import type { Frequency, Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { assert } from '../errors';
import { audit } from '../audit';
import type { Actor } from './items';
import { fromISO, today } from '@/domain/dates';
import { r2 } from '@/domain/money';
import { COVERING_GOODS_INVOICE } from './goods-expense';
import { countLabel, plural } from '@/domain/plural';

// =============================================================================
//  Troškovi: ručni i ponavljajući troškovi, izmjene pojedinih rata, kategorije.
//  Troškovi iz primki, otpisa i ulaznih računa mijenjaju se na izvornom dokumentu.
// =============================================================================

export interface ExpenseInput {
  date: string;
  categoryId?: string | null;
  description: string;
  partnerId?: string | null;
  netAmount: number;
  vatAmount: number;
  paid: boolean;
  frequency?: Frequency | null;
  recurringUntil?: string | null;
  note?: string | null;
}

type Overrides = Record<string, { amount?: number; skipped?: boolean }>;

async function manualExpense(tx: Tx, actor: Actor, id: string) {
  const e = await tx.expense.findFirst({ where: { id, companyId: actor.companyId } });
  assert(e, 'Trošak ne postoji.');
  assert(e.source === 'MANUAL', 'Trošak je knjižen iz dokumenta (primka, otpis, ulazni račun) — mijenja se na tom dokumentu.');
  return e;
}

export async function saveExpense(tx: Tx, actor: Actor, id: string | null, input: ExpenseInput) {
  assert(input.description.trim(), 'Opis je obavezan.');
  if (input.categoryId) {
    assert(await tx.expenseCategory.count({ where: { id: input.categoryId, companyId: actor.companyId } }), 'Kategorija ne postoji.');
  }
  if (input.partnerId) {
    assert(await tx.partner.count({ where: { id: input.partnerId, companyId: actor.companyId } }), 'Partner ne postoji.');
  }
  if (input.frequency && input.recurringUntil) assert(input.recurringUntil >= input.date, 'Datum „do" ne može biti prije prvog datuma.');
  const data = {
    date: fromISO(input.date),
    categoryId: input.categoryId ?? null,
    description: input.description.trim(),
    partnerId: input.partnerId ?? null,
    netAmount: r2(input.netAmount),
    vatAmount: r2(input.vatAmount),
    paid: input.paid,
    frequency: input.frequency ?? null,
    recurringUntil: input.frequency && input.recurringUntil ? fromISO(input.recurringUntil) : null,
    note: input.note ?? null,
  };
  if (id) {
    const old = await manualExpense(tx, actor, id);
    await tx.expense.update({
      where: { id },
      data: { ...data, paidDate: input.paid ? (old.paidDate ?? fromISO(today())) : null, ...(data.frequency ? {} : { overrides: {} }) },
    });
    await audit(tx, actor, { entity: 'expense', entityId: id, action: 'update', summary: `Trošak „${data.description}" izmijenjen` });
    return { id };
  }
  const e = await tx.expense.create({
    data: { companyId: actor.companyId, ...data, paidDate: input.paid ? fromISO(today()) : null, source: 'MANUAL', createdBy: actor.name },
    select: { id: true },
  });
  await audit(tx, actor, { entity: 'expense', entityId: e.id, action: 'create', summary: `Trošak „${data.description}" (${data.netAmount.toFixed(2)})` });
  return e;
}

export async function deleteExpense(tx: Tx, actor: Actor, id: string) {
  const e = await manualExpense(tx, actor, id);
  // prilozi nisu vezani stranim ključem — brišu se s troškom
  await tx.attachment.deleteMany({ where: { companyId: actor.companyId, entity: 'expense', entityId: id } });
  await tx.expense.delete({ where: { id } });
  await audit(tx, actor, { entity: 'expense', entityId: id, action: 'delete', summary: `Trošak „${e.description}" obrisan` });
}

/**
 * Izmjena jedne rate ponavljajućeg troška (ključ YYYY-MM): drugi iznos ili
 * preskakanje. Bez iznosa i bez preskakanja rata se vraća na zadano.
 */
export async function saveOccurrence(tx: Tx, actor: Actor, id: string, period: string, ov: { amount: number | null; skipped: boolean }) {
  const e = await manualExpense(tx, actor, id);
  assert(e.frequency, 'Trošak se ne ponavlja.');
  assert(/^\d{4}-\d{2}$/.test(period), 'Neispravno razdoblje.');
  const overrides: Overrides = { ...((e.overrides as Overrides | null) ?? {}) };
  if (ov.skipped) overrides[period] = { skipped: true };
  else if (ov.amount !== null && r2(ov.amount) !== r2(Number(e.netAmount))) overrides[period] = { amount: r2(ov.amount) };
  else delete overrides[period];
  await tx.expense.update({ where: { id }, data: { overrides: overrides as Prisma.InputJsonValue } });
  await audit(tx, actor, {
    entity: 'expense',
    entityId: id,
    action: 'occurrence',
    summary: `Trošak „${e.description}", ${period}: ${ov.skipped ? 'preskočen' : ov.amount !== null ? `iznos ${r2(ov.amount).toFixed(2)}` : 'vraćen na zadano'}`,
  });
}

export async function setExpensesPaid(tx: Tx, actor: Actor, ids: string[], paid: boolean) {
  const rows = await tx.expense.findMany({
    where: { id: { in: ids }, companyId: actor.companyId },
    select: { id: true, source: true, receipt: { select: { id: true, number: true, orderId: true } } },
  });
  assert(rows.length === ids.length, 'Neki troškovi ne postoje.');
  // plaćenost ulaznog računa živi na računu (i javlja se posredniku); primka i otpis nemaju svoj dokument plaćanja
  assert(!rows.some((r) => r.source === 'SUPPLIER_INVOICE'), 'Plaćanje ulaznog računa označava se na ulaznom računu (Nabava → Ulazni računi).');
  // trošak primke čiju robu nosi ulazni račun za robu: plaćenost prelazi s računa na primku (jedan smjer) —
  // plaća se račun, inače bi primka bila plaćena, a račun (i posrednik) ne
  for (const r of rows) {
    if (!r.receipt) continue;
    const si = await tx.supplierInvoice.findFirst({
      where: {
        companyId: actor.companyId,
        // račun za robu koji troši trošak primki (usklađivanje po narudžbenici, goods-expense.ts)
        ...COVERING_GOODS_INVOICE,
        OR: [{ receiptId: r.receipt.id }, ...(r.receipt.orderId ? [{ orderId: r.receipt.orderId }] : [])],
      },
      select: { internalNo: true },
    });
    assert(!si, `Trošak primke ${r.receipt.number} plaća se preko ulaznog računa za robu ${si?.internalNo ?? ''} (Nabava → Ulazni računi) — plaćenost računa prelazi na primku.`);
  }
  // već plaćenima se ne mijenja datum plaćanja
  if (paid) await tx.expense.updateMany({ where: { id: { in: ids }, companyId: actor.companyId, paid: false }, data: { paid: true, paidDate: fromISO(today()) } });
  else await tx.expense.updateMany({ where: { id: { in: ids }, companyId: actor.companyId }, data: { paid: false, paidDate: null } });
  await audit(tx, actor, { entity: 'expense', action: paid ? 'paid' : 'unpaid', summary: `${countLabel(ids.length, 'trošak', 'troška', 'troškova')} ${plural(ids.length, 'označen', 'označena', 'označeno')} kao ${paid ? 'plaćeno' : 'neplaćeno'}` });
}

// ---------------------------------------------------------------- kategorije

export async function saveExpenseCategory(tx: Tx, actor: Actor, id: string | null, name: string) {
  const n = name.trim();
  assert(n, 'Naziv kategorije je obavezan.');
  const dup = await tx.expenseCategory.findFirst({ where: { companyId: actor.companyId, name: { equals: n, mode: 'insensitive' }, ...(id ? { id: { not: id } } : {}) } });
  assert(!dup, `Kategorija „${n}" već postoji.`);
  if (id) {
    const c = await tx.expenseCategory.findFirst({ where: { id, companyId: actor.companyId } });
    assert(c, 'Kategorija ne postoji.');
    // na ove nazive se vežu automatski troškovi primki i otpisa
    assert(!['Nabava robe', 'Otpis opreme'].includes(c.name), `Kategorija „${c.name}" je sistemska i ne preimenuje se.`);
    await tx.expenseCategory.update({ where: { id }, data: { name: n } });
    await audit(tx, actor, { entity: 'expenseCategory', entityId: id, action: 'update', summary: `Kategorija troška „${c.name}" → „${n}"` });
    return { id };
  }
  const c = await tx.expenseCategory.create({ data: { companyId: actor.companyId, name: n }, select: { id: true } });
  await audit(tx, actor, { entity: 'expenseCategory', entityId: c.id, action: 'create', summary: `Kategorija troška „${n}"` });
  return c;
}

// ---------------------------------------------------------------- ulazni računi (knjiga URA)
// Ulazni računi i njihov trošak → supplier-invoices.ts (ovdje ostaju izvozi zbog starih uvoza).

export {
  saveSupplierInvoice, setSupplierInvoicesPaid, deleteSupplierInvoice, deleteSupplierInvoices, rebookSupplierInvoice, type SupplierInvoiceInput,
} from './supplier-invoices';
