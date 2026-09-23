import 'server-only';
import type { Frequency, Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { assert } from '../errors';
import { audit } from '../audit';
import type { Actor } from './items';
import { fromISO, today } from '@/domain/dates';
import { r2 } from '@/domain/money';
import { nextDocNumber } from '../numbering';
import { expenseCategoryId } from './purchasing';

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
  const rows = await tx.expense.findMany({ where: { id: { in: ids }, companyId: actor.companyId }, select: { id: true, source: true } });
  assert(rows.length === ids.length, 'Neki troškovi ne postoje.');
  assert(rows.every((r) => r.source === 'MANUAL'), 'Plaćanje troškova iz dokumenata mijenja se na dokumentu (npr. ulaznom računu).');
  await tx.expense.updateMany({ where: { id: { in: ids } }, data: { paid, paidDate: paid ? fromISO(today()) : null } });
  await audit(tx, actor, { entity: 'expense', action: paid ? 'paid' : 'unpaid', summary: `${ids.length} troškova označeno kao ${paid ? 'plaćeno' : 'neplaćeno'}` });
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
// Ulazni račun dobavljača po želji knjiži jedan povezani trošak.

export interface SupplierInvoiceInput {
  supplierId: string;
  number: string;
  issueDate: string;
  dueDate?: string | null;
  netAmount: number;
  vatAmount: number;
  total?: number | null;
  category?: string | null;
  note?: string | null;
  paidDate?: string | null;
  /** Knjiži kao trošak (stvara ili ažurira povezani trošak). */
  book: boolean;
}

export async function saveSupplierInvoice(tx: Tx, actor: Actor, id: string | null, input: SupplierInvoiceInput) {
  const supplier = await tx.partner.findFirst({ where: { id: input.supplierId, companyId: actor.companyId }, select: { id: true, name: true } });
  assert(supplier, 'Dobavljač ne postoji.');
  const number = input.number.trim();
  assert(number, 'Broj računa dobavljača je obavezan.');
  const dup = await tx.supplierInvoice.findFirst({
    where: { companyId: actor.companyId, supplierId: supplier.id, number, ...(id ? { id: { not: id } } : {}) },
    select: { internalNo: true },
  });
  assert(!dup, `Račun ${number} tog dobavljača već je upisan (${dup?.internalNo}).`);
  const net = r2(input.netAmount);
  const vat = r2(input.vatAmount);
  const total = input.total ? r2(input.total) : r2(net + vat);
  const data = {
    supplierId: supplier.id,
    number,
    issueDate: fromISO(input.issueDate),
    dueDate: input.dueDate ? fromISO(input.dueDate) : null,
    netAmount: net,
    vatAmount: vat,
    total,
    category: input.category ?? null,
    note: input.note ?? null,
    paidDate: input.paidDate ? fromISO(input.paidDate) : null,
  };

  let si: { id: string; internalNo: string };
  if (id) {
    const old = await tx.supplierInvoice.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, internalNo: true } });
    assert(old, 'Ulazni račun ne postoji.');
    await tx.supplierInvoice.update({ where: { id }, data });
    si = old;
  } else {
    const internalNo = await nextDocNumber(tx, actor.companyId, 'SUPPLIER_INVOICE', Number(input.issueDate.slice(0, 4)));
    si = await tx.supplierInvoice.create({ data: { companyId: actor.companyId, internalNo, ...data }, select: { id: true, internalNo: true } });
  }

  if (input.book) {
    const categoryId = input.category ? await expenseCategoryId(tx, actor.companyId, input.category) : null;
    const expense = {
      date: data.issueDate,
      categoryId,
      description: `Ulazni račun ${number} — ${supplier.name}`,
      partnerId: supplier.id,
      netAmount: net,
      vatAmount: vat,
      paid: !!data.paidDate,
      paidDate: data.paidDate,
      note: input.note ?? null,
    };
    await tx.expense.upsert({
      where: { supplierInvoiceId: si.id },
      update: expense,
      create: { companyId: actor.companyId, ...expense, source: 'SUPPLIER_INVOICE', supplierInvoiceId: si.id, createdBy: actor.name },
    });
  } else {
    await tx.expense.deleteMany({ where: { supplierInvoiceId: si.id, companyId: actor.companyId } });
  }

  await audit(tx, actor, {
    entity: 'supplierInvoice',
    entityId: si.id,
    action: id ? 'update' : 'create',
    summary: `Ulazni račun ${si.internalNo} (${number}, ${supplier.name}) ${id ? 'izmijenjen' : 'upisan'}`,
  });
  return si;
}

export async function setSupplierInvoicesPaid(tx: Tx, actor: Actor, ids: string[], paidDate: string | null) {
  const found = await tx.supplierInvoice.findMany({ where: { id: { in: ids }, companyId: actor.companyId }, select: { id: true } });
  assert(found.length === ids.length, 'Neki računi ne postoje.');
  const d = paidDate ? fromISO(paidDate) : null;
  await tx.supplierInvoice.updateMany({ where: { id: { in: ids }, companyId: actor.companyId }, data: { paidDate: d } });
  await tx.expense.updateMany({ where: { supplierInvoiceId: { in: ids }, companyId: actor.companyId }, data: { paid: !!d, paidDate: d } });
  await audit(tx, actor, {
    entity: 'supplierInvoice',
    action: d ? 'paid' : 'unpaid',
    summary: `${ids.length} ulaznih računa označeno kao ${d ? `plaćeno (${paidDate})` : 'neplaćeno'}`,
  });
  return ids.length;
}

export async function deleteSupplierInvoice(tx: Tx, actor: Actor, id: string) {
  const si = await tx.supplierInvoice.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, internalNo: true, number: true } });
  assert(si, 'Ulazni račun ne postoji.');
  await tx.expense.deleteMany({ where: { supplierInvoiceId: id, companyId: actor.companyId } });
  await tx.supplierInvoice.delete({ where: { id } });
  await audit(tx, actor, { entity: 'supplierInvoice', entityId: id, action: 'delete', summary: `Ulazni račun ${si.internalNo} (${si.number}) obrisan` });
}
