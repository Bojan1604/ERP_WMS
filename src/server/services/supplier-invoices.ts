import 'server-only';
import type { Tx } from '../db';
import { assert, DomainError } from '../errors';
import { audit } from '../audit';
import type { Actor } from './items';
import { nextDocNumber } from '../numbering';
import { expenseCategoryId, PURCHASE_CATEGORY } from './purchasing';
import { fromISO, toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { isValidOib, supplierVat } from '@/domain/tax';
import { invoiceExpenseMode, type InvoiceExpenseMode } from '@/domain/purchase-links';

// =============================================================================
//  Ulazni računi (knjiga URA): upis, veza s narudžbenicom/primkom, trošak.
//  Pravilo troška robe (domain/purchase-links): trošak se knjiži jednom — ako je
//  roba povezanog računa već knjižena primkom, račun nema vlastiti trošak.
// =============================================================================

export interface SupplierInvoiceInput {
  /** Postojeći partner; bez njega se dobavljač otvara iz naziva i OIB-a. */
  supplierId?: string | null;
  supplierName?: string | null;
  supplierOib?: string | null;
  number: string;
  issueDate: string;
  dueDate?: string | null;
  netAmount: number;
  vatAmount: number;
  total?: number | null;
  vatPct?: number | null;
  currency?: string | null;
  category?: string | null;
  note?: string | null;
  paidDate?: string | null;
  /** Veza s nabavom (undefined = bez promjene, null = ukloni vezu). */
  orderId?: string | null;
  receiptId?: string | null;
  /** Knjiži kao trošak (stvara ili ažurira povezani trošak, osim kad je roba knjižena primkom). */
  book: boolean;
}

/**
 * Dobavljač ulaznog računa: odabrani partner ili — kod slobodnog unosa — partner
 * s istim OIB-om / nazivom; ako ga nema, otvara se novi (dobavljač) pri knjiženju.
 */
export async function resolveSupplier(tx: Tx, actor: Actor, input: { supplierId?: string | null; supplierName?: string | null; supplierOib?: string | null }) {
  if (input.supplierId) {
    const p = await tx.partner.findFirst({ where: { id: input.supplierId, companyId: actor.companyId }, select: { id: true, name: true, oib: true } });
    assert(p, 'Dobavljač ne postoji.');
    return { ...p, created: false };
  }
  const name = input.supplierName?.replace(/\s+/g, ' ').trim() || null;
  const oib = input.supplierOib?.replace(/\s+/g, '').replace(/^HR/i, '') || null;
  assert(name || oib, 'Odaberite dobavljača ili upišite njegov naziv i OIB.');
  assert(!oib || isValidOib(oib), `OIB „${oib}" nije ispravan.`);
  const existing =
    (oib ? await tx.partner.findFirst({ where: { companyId: actor.companyId, oib }, select: { id: true, name: true, oib: true, isSupplier: true } }) : null) ??
    (name ? await tx.partner.findFirst({ where: { companyId: actor.companyId, name: { equals: name, mode: 'insensitive' } }, select: { id: true, name: true, oib: true, isSupplier: true } }) : null);
  if (existing) {
    if (!existing.isSupplier) await tx.partner.update({ where: { id: existing.id }, data: { isSupplier: true } });
    return { id: existing.id, name: existing.name, oib: existing.oib, created: false };
  }
  assert(name, 'Upišite naziv dobavljača.');
  const p = await tx.partner.create({
    data: { companyId: actor.companyId, name, oib, isSupplier: true, isCustomer: false, note: 'Otvoren iz ulaznog računa — dopunite adresu.' },
    select: { id: true, name: true, oib: true },
  });
  await audit(tx, actor, { entity: 'partner', entityId: p.id, action: 'create', summary: `Dobavljač ${name}${oib ? ` (OIB ${oib})` : ''} otvoren iz ulaznog računa` });
  return { ...p, created: true };
}

/** Primke povezane s računom: izravno ili sve proknjižene primke povezane narudžbenice. */
async function linkedReceiptIds(tx: Tx, companyId: string, si: { orderId: string | null; receiptId: string | null }) {
  const ids = new Set<string>();
  if (si.receiptId) ids.add(si.receiptId);
  if (si.orderId) {
    const rs = await tx.goodsReceipt.findMany({ where: { companyId, orderId: si.orderId, status: 'POSTED' }, select: { id: true } });
    for (const r of rs) ids.add(r.id);
  }
  return [...ids];
}

/**
 * Trošak ulaznog računa po pravilu „roba se knjiži jednom": ako povezane primke
 * imaju trošak, vlastiti trošak računa se ne stvara (postojeći se briše), a
 * plaćenost računa prelazi na troškove primki. Vraća način knjiženja.
 */
export async function applyInvoiceExpense(tx: Tx, actor: Actor, id: string, book: boolean): Promise<InvoiceExpenseMode> {
  const si = await tx.supplierInvoice.findFirst({
    where: { id, companyId: actor.companyId },
    select: {
      id: true, number: true, status: true, orderId: true, receiptId: true, issueDate: true, netAmount: true, vatAmount: true, paidDate: true, category: true, note: true,
      supplier: { select: { id: true, name: true } },
    },
  });
  assert(si, 'Ulazni račun ne postoji.');
  const receipts = await linkedReceiptIds(tx, actor.companyId, si);
  const receiptExpenses = receipts.length ? await tx.expense.count({ where: { companyId: actor.companyId, receiptId: { in: receipts } } }) : 0;
  const mode = invoiceExpenseMode({ book, rejected: si.status === 'REJECTED', receiptExpenses });
  if (mode === 'own') {
    const expense = {
      date: si.issueDate,
      categoryId: si.category ? await expenseCategoryId(tx, actor.companyId, si.category) : null,
      description: `Ulazni račun ${si.number} — ${si.supplier.name}`,
      partnerId: si.supplier.id,
      netAmount: r2(num(si.netAmount)),
      vatAmount: r2(num(si.vatAmount)),
      paid: !!si.paidDate,
      paidDate: si.paidDate,
      note: si.note ?? null,
    };
    await tx.expense.upsert({
      where: { supplierInvoiceId: si.id },
      update: expense,
      create: { companyId: actor.companyId, ...expense, source: 'SUPPLIER_INVOICE', supplierInvoiceId: si.id, createdBy: actor.name },
    });
  } else {
    await tx.expense.deleteMany({ where: { supplierInvoiceId: si.id, companyId: actor.companyId } });
  }
  if (mode === 'receipt' && si.paidDate) {
    // račun robe je plaćen — plaćen je i trošak nabave s primki
    await tx.expense.updateMany({ where: { companyId: actor.companyId, receiptId: { in: receipts }, paid: false }, data: { paid: true, paidDate: si.paidDate } });
  }
  return mode;
}

/** Narudžbenica i primka za vezu s računom — moraju biti firme i istog dobavljača. */
async function resolveLinks(tx: Tx, actor: Actor, supplierId: string, orderId: string | null, receiptId: string | null) {
  let oid = orderId;
  if (receiptId) {
    const r = await tx.goodsReceipt.findFirst({ where: { id: receiptId, companyId: actor.companyId }, select: { id: true, number: true, supplierId: true, orderId: true, status: true } });
    assert(r, 'Primka ne postoji.');
    assert(r.status === 'POSTED', `Primka ${r.number} je stornirana.`);
    assert(!r.supplierId || r.supplierId === supplierId, `Primka ${r.number} je drugog dobavljača.`);
    assert(!oid || !r.orderId || r.orderId === oid, `Primka ${r.number} nije po odabranoj narudžbenici.`);
    oid = oid ?? r.orderId;
  }
  if (oid) {
    const o = await tx.purchaseOrder.findFirst({ where: { id: oid, companyId: actor.companyId }, select: { id: true, number: true, supplierId: true } });
    assert(o, 'Narudžbenica ne postoji.');
    assert(o.supplierId === supplierId, `Narudžbenica ${o.number} je drugog dobavljača.`);
  }
  return { orderId: oid, receiptId };
}

export async function saveSupplierInvoice(tx: Tx, actor: Actor, id: string | null, input: SupplierInvoiceInput) {
  const old = id
    ? await tx.supplierInvoice.findFirst({
        where: { id, companyId: actor.companyId },
        select: {
          id: true, internalNo: true, source: true, status: true, paidDate: true, eInvoiceId: true, supplierId: true, number: true, issueDate: true,
          netAmount: true, vatAmount: true, total: true, orderId: true, receiptId: true, supplierName: true, supplierOib: true,
        },
      })
    : null;
  assert(!id || old, 'Ulazni račun ne postoji.');
  if (old?.source === 'EINVOICE') {
    // dobavljač, broj, datum i iznosi eRačuna dolaze iz XML-a (pravni original) i ne mijenjaju se
    input = {
      ...input,
      supplierId: old.supplierId,
      number: old.number,
      issueDate: toISO(old.issueDate),
      netAmount: Number(old.netAmount),
      vatAmount: Number(old.vatAmount),
      total: Number(old.total),
    };
  }
  // eRačun se plaća tek nakon prihvaćanja: posrednik status „plaćen" prije „prihvaćen" odbija, a plaćeni se više ne može odbiti
  assert(
    !(old?.source === 'EINVOICE' && old.status === 'RECEIVED' && !old.paidDate && input.paidDate),
    'Zaprimljeni eRačun prvo prihvatite, pa ga onda označite plaćenim.',
  );
  if (old?.status === 'REJECTED') {
    assert(!input.paidDate, 'Odbijeni račun se ne može označiti plaćenim.');
    assert(!input.book, 'Odbijeni račun se ne knjiži kao trošak.');
  }
  const supplier = await resolveSupplier(tx, actor, input);
  const number = input.number.trim();
  assert(number, 'Broj računa dobavljača je obavezan.');
  // eRačun je upisan preuzimanjem i može biti označen „Mogući duplikat" — broj mu se ne mijenja, pa ga provjera ne smije blokirati
  if (old?.source !== 'EINVOICE') {
    const dup = await tx.supplierInvoice.findFirst({
      where: { companyId: actor.companyId, supplierId: supplier.id, number, ...(id ? { id: { not: id } } : {}) },
      select: { internalNo: true },
    });
    assert(!dup, `Račun ${number} tog dobavljača već je upisan (${dup?.internalNo}).`);
  }
  const links = await resolveLinks(
    tx,
    actor,
    supplier.id,
    input.orderId === undefined ? (old?.orderId ?? null) : input.orderId,
    input.receiptId === undefined ? (old?.receiptId ?? null) : input.receiptId,
  );
  const net = r2(input.netAmount);
  const vat = r2(input.vatAmount);
  const total = input.total ? r2(input.total) : r2(net + vat);
  const currency = (input.currency ?? 'EUR').trim().toUpperCase() || 'EUR';
  assert(/^[A-Z]{3}$/.test(currency), 'Valuta mora biti troslovna oznaka (npr. EUR).');
  assert(input.vatPct === undefined || input.vatPct === null || (input.vatPct >= 0 && input.vatPct <= 100), 'Stopa PDV-a mora biti između 0 i 100 %.');
  const data = {
    supplierId: supplier.id,
    // kako je dobavljač upisan (slobodni unos) ostaje zapisano uz račun
    supplierName: input.supplierId ? (old?.supplierName ?? supplier.name) : (input.supplierName?.trim() || supplier.name),
    supplierOib: input.supplierId ? (old?.supplierOib ?? supplier.oib) : (input.supplierOib?.trim() || supplier.oib),
    number,
    issueDate: fromISO(input.issueDate),
    dueDate: input.dueDate ? fromISO(input.dueDate) : null,
    netAmount: net,
    vatAmount: vat,
    total,
    ...(input.vatPct !== undefined ? { vatPct: input.vatPct === null ? null : r2(input.vatPct) } : {}),
    currency,
    category: input.category ?? null,
    note: input.note ?? null,
    paidDate: input.paidDate ? fromISO(input.paidDate) : null,
    orderId: links.orderId,
    receiptId: links.receiptId,
  };

  let si: { id: string; internalNo: string };
  if (id && old) {
    await tx.supplierInvoice.update({ where: { id }, data });
    si = { id: old.id, internalNo: old.internalNo };
  } else {
    const internalNo = await nextDocNumber(tx, actor.companyId, 'SUPPLIER_INVOICE', Number(input.issueDate.slice(0, 4)));
    si = await tx.supplierInvoice.create({ data: { companyId: actor.companyId, internalNo, ...data }, select: { id: true, internalNo: true } });
  }

  const mode = await applyInvoiceExpense(tx, actor, si.id, input.book);

  await audit(tx, actor, {
    entity: 'supplierInvoice',
    entityId: si.id,
    action: id ? 'update' : 'create',
    summary:
      `Ulazni račun ${si.internalNo} (${number}, ${supplier.name}) ${id ? 'izmijenjen' : 'upisan'}` +
      (supplier.created ? ' — otvoren novi dobavljač' : '') +
      (mode === 'receipt' ? ' — trošak robe knjižen primkom' : ''),
  });
  // eRačun koji je ovim spremanjem postao plaćen javlja se posredniku (nakon transakcije)
  const newlyPaid = old?.source === 'EINVOICE' && !old.paidDate && !!data.paidDate;
  return { ...si, newlyPaid, eInvoiceId: old?.eInvoiceId ?? null, mode, supplierCreated: supplier.created };
}

export async function setSupplierInvoicesPaid(tx: Tx, actor: Actor, ids: string[], paidDate: string | null) {
  const found = await tx.supplierInvoice.findMany({
    where: { id: { in: ids }, companyId: actor.companyId },
    select: { id: true, status: true, source: true, internalNo: true, orderId: true, receiptId: true },
  });
  assert(found.length === ids.length, 'Neki računi ne postoje.');
  const rejected = found.filter((f) => f.status === 'REJECTED');
  assert(!paidDate || !rejected.length, `Odbijeni računi se ne mogu označiti plaćenima: ${rejected.map((r) => r.internalNo).slice(0, 10).join(', ')}`);
  const pending = found.filter((f) => f.source === 'EINVOICE' && f.status === 'RECEIVED');
  assert(!paidDate || !pending.length, `Zaprimljene eRačune prvo prihvatite, pa ih onda označite plaćenima: ${pending.map((r) => r.internalNo).slice(0, 10).join(', ')}`);
  const d = paidDate ? fromISO(paidDate) : null;
  await tx.supplierInvoice.updateMany({ where: { id: { in: ids }, companyId: actor.companyId }, data: { paidDate: d } });
  await tx.expense.updateMany({ where: { supplierInvoiceId: { in: ids }, companyId: actor.companyId }, data: { paid: !!d, paidDate: d } });
  if (d) {
    // plaćen račun robe: plaćen je i trošak nabave s povezanih primki
    const receipts = new Set<string>();
    for (const f of found) for (const r of await linkedReceiptIds(tx, actor.companyId, f)) receipts.add(r);
    if (receipts.size) {
      await tx.expense.updateMany({ where: { companyId: actor.companyId, receiptId: { in: [...receipts] }, paid: false }, data: { paid: true, paidDate: d } });
    }
  }
  await audit(tx, actor, {
    entity: 'supplierInvoice',
    action: d ? 'paid' : 'unpaid',
    summary: `${ids.length} ulaznih računa označeno kao ${d ? `plaćeno (${paidDate})` : 'neplaćeno'}`,
  });
  return ids.length;
}

export async function deleteSupplierInvoice(tx: Tx, actor: Actor, id: string) {
  const si = await tx.supplierInvoice.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, internalNo: true, number: true, source: true, status: true } });
  assert(si, 'Ulazni račun ne postoji.');
  // prihvaćen/odbijen eRačun je javljen posredniku (i Poreznoj upravi) — zapis ostaje
  assert(si.source !== 'EINVOICE' || si.status === 'RECEIVED', `eRačun ${si.internalNo} koji je prihvaćen ili odbijen kod posrednika se ne briše.`);
  await tx.expense.deleteMany({ where: { supplierInvoiceId: id, companyId: actor.companyId } });
  await tx.attachment.deleteMany({ where: { companyId: actor.companyId, entity: 'supplierInvoice', entityId: id } });
  await tx.supplierInvoice.delete({ where: { id } });
  await audit(tx, actor, { entity: 'supplierInvoice', entityId: id, action: 'delete', summary: `Ulazni račun ${si.internalNo} (${si.number}) obrisan` });
  return si;
}

/** Skupno brisanje: sve ili ništa (jedan eRačun koji se ne smije brisati zaustavlja cijelo brisanje). */
export async function deleteSupplierInvoices(tx: Tx, actor: Actor, ids: string[]) {
  const unique = [...new Set(ids)];
  assert(unique.length, 'Označite barem jedan račun.');
  for (const id of unique) await deleteSupplierInvoice(tx, actor, id);
  return unique.length;
}

/**
 * „Knjiži ponovno": trošak računa je obrisan (npr. storno primke) ili račun nije
 * knjižen — knjiži se po pravilu (ako je roba ipak knjižena primkom, ništa se ne stvara).
 */
export async function rebookSupplierInvoice(tx: Tx, actor: Actor, id: string) {
  const si = await tx.supplierInvoice.findFirst({ where: { id, companyId: actor.companyId }, select: { internalNo: true, status: true, expense: { select: { id: true } } } });
  assert(si, 'Ulazni račun ne postoji.');
  assert(si.status !== 'REJECTED', 'Odbijeni račun se ne knjiži kao trošak.');
  assert(si.status !== 'RECEIVED', 'Zaprimljeni eRačun prvo prihvatite — prihvaćanjem se i knjiži.');
  assert(!si.expense, 'Račun je već knjižen kao trošak.');
  const mode = await applyInvoiceExpense(tx, actor, id, true);
  await audit(tx, actor, {
    entity: 'supplierInvoice',
    entityId: id,
    action: 'rebook',
    summary: mode === 'own' ? `Ulazni račun ${si.internalNo} ponovno knjižen kao trošak` : `Ulazni račun ${si.internalNo}: trošak robe je knjižen primkom`,
  });
  return mode;
}

// ---------------------------------------------------------------- račun dobavljača na narudžbenici

export interface OrderInvoiceInput {
  supplierInvoiceNo: string | null;
  supplierInvoiceDate: string | null;
  supplierInvoiceDueDate: string | null;
  supplierInvoiceCurrency: string | null;
  supplierInvoiceNet: number | null;
  supplierInvoiceVat: number | null;
  supplierInvoiceTotal: number | null;
}

/** Podaci računa dobavljača upisani na narudžbenici; kad je roba zaprimljena, iz njih nastaje ulazni račun. */
export async function saveOrderInvoice(tx: Tx, actor: Actor, orderId: string, input: OrderInvoiceInput) {
  const o = await tx.purchaseOrder.findFirst({ where: { id: orderId, companyId: actor.companyId }, select: { id: true, number: true } });
  assert(o, 'Narudžbenica ne postoji.');
  const cur = input.supplierInvoiceCurrency?.trim().toUpperCase() || null;
  assert(!cur || /^[A-Z]{3}$/.test(cur), 'Valuta mora biti troslovna oznaka (npr. EUR).');
  for (const v of [input.supplierInvoiceNet, input.supplierInvoiceVat, input.supplierInvoiceTotal]) assert(v === null || v >= 0, 'Iznosi računa ne mogu biti negativni.');
  const net = input.supplierInvoiceNet === null ? null : r2(input.supplierInvoiceNet);
  const vat = input.supplierInvoiceVat === null ? null : r2(input.supplierInvoiceVat);
  await tx.purchaseOrder.update({
    where: { id: orderId },
    data: {
      supplierInvoiceNo: input.supplierInvoiceNo?.trim() || null,
      supplierInvoiceDate: input.supplierInvoiceDate ? fromISO(input.supplierInvoiceDate) : null,
      supplierInvoiceDueDate: input.supplierInvoiceDueDate ? fromISO(input.supplierInvoiceDueDate) : null,
      supplierInvoiceCurrency: cur,
      supplierInvoiceNet: net,
      supplierInvoiceVat: vat,
      supplierInvoiceTotal: input.supplierInvoiceTotal === null ? (net === null ? null : r2(net + (vat ?? 0))) : r2(input.supplierInvoiceTotal),
    },
  });
  await audit(tx, actor, {
    entity: 'purchaseOrder',
    entityId: orderId,
    action: 'supplierInvoice',
    summary: input.supplierInvoiceNo ? `Narudžbenica ${o.number}: račun dobavljača ${input.supplierInvoiceNo}` : `Narudžbenica ${o.number}: podaci računa dobavljača obrisani`,
  });
  return syncOrderSupplierInvoice(tx, actor, orderId);
}

/**
 * Račun dobavljača s narudžbenice postaje ulazni račun (povezan s narudžbenicom)
 * čim je roba barem djelomično zaprimljena — tako ga vidi knjigovođa. Postojeći
 * povezani ručni račun se ažurira; eRačun se samo povezuje. Trošak robe ostaje na
 * primkama (pravilo „knjiži se jednom").
 */
export async function syncOrderSupplierInvoice(tx: Tx, actor: Actor, orderId: string) {
  const o = await tx.purchaseOrder.findFirst({
    where: { id: orderId, companyId: actor.companyId },
    select: {
      id: true, number: true, supplierId: true, total: true, supplierInvoiceNo: true, supplierInvoiceDate: true, supplierInvoiceDueDate: true,
      supplierInvoiceCurrency: true, supplierInvoiceNet: true, supplierInvoiceVat: true, supplierInvoiceTotal: true,
      supplier: { select: { name: true, oib: true } },
      receipts: { where: { status: 'POSTED' }, orderBy: { date: 'desc' }, select: { date: true }, take: 1 },
    },
  });
  assert(o, 'Narudžbenica ne postoji.');
  if (!o.supplierInvoiceNo || !o.receipts.length) return null;
  const existing =
    (await tx.supplierInvoice.findFirst({ where: { companyId: actor.companyId, orderId: o.id, supplierId: o.supplierId, number: o.supplierInvoiceNo }, select: { id: true, source: true, internalNo: true } })) ??
    (await tx.supplierInvoice.findFirst({ where: { companyId: actor.companyId, supplierId: o.supplierId, number: o.supplierInvoiceNo }, select: { id: true, source: true, internalNo: true } })) ??
    (await tx.supplierInvoice.findFirst({ where: { companyId: actor.companyId, orderId: o.id, source: 'MANUAL' }, orderBy: { createdAt: 'asc' }, select: { id: true, source: true, internalNo: true } }));
  const net = o.supplierInvoiceNet === null ? r2(num(o.total)) : r2(num(o.supplierInvoiceNet));
  const vat = o.supplierInvoiceVat === null ? 0 : r2(num(o.supplierInvoiceVat));
  const issue = toISO(o.supplierInvoiceDate ?? o.receipts[0].date);
  const fields = {
    number: o.supplierInvoiceNo,
    issueDate: fromISO(issue),
    dueDate: o.supplierInvoiceDueDate,
    netAmount: net,
    vatAmount: vat,
    total: o.supplierInvoiceTotal === null ? r2(net + vat) : r2(num(o.supplierInvoiceTotal)),
    currency: o.supplierInvoiceCurrency ?? 'EUR',
  };
  let id: string;
  if (existing) {
    id = existing.id;
    // eRačun je pravni original — samo se povezuje s narudžbenicom
    await tx.supplierInvoice.update({ where: { id }, data: existing.source === 'EINVOICE' ? { orderId: o.id } : { ...fields, orderId: o.id } });
  } else {
    const internalNo = await nextDocNumber(tx, actor.companyId, 'SUPPLIER_INVOICE', Number(issue.slice(0, 4)));
    const si = await tx.supplierInvoice.create({
      data: {
        companyId: actor.companyId,
        internalNo,
        supplierId: o.supplierId,
        supplierName: o.supplier.name,
        supplierOib: o.supplier.oib,
        ...fields,
        category: PURCHASE_CATEGORY,
        note: `Narudžbenica ${o.number}`,
        orderId: o.id,
      },
      select: { id: true },
    });
    id = si.id;
    await audit(tx, actor, { entity: 'supplierInvoice', entityId: id, action: 'create', summary: `Ulazni račun ${internalNo} (${o.supplierInvoiceNo}) nastao iz narudžbenice ${o.number}` });
  }
  await applyInvoiceExpense(tx, actor, id, true);
  return id;
}

/**
 * Knjiženje troška primke naknadno (zaprimljeno bez knjiženja ili trošak obrisan) —
 * odbija se ako je roba već knjižena vlastitim troškom povezanog ulaznog računa.
 */
export async function bookReceiptExpense(tx: Tx, actor: Actor, receiptId: string) {
  const r = await tx.goodsReceipt.findFirst({
    where: { id: receiptId, companyId: actor.companyId },
    select: { id: true, number: true, date: true, status: true, total: true, orderId: true, supplierId: true, supplier: { select: { country: true } }, expense: { select: { id: true } } },
  });
  assert(r, 'Primka ne postoji.');
  assert(r.status === 'POSTED', 'Stornirana primka se ne knjiži.');
  assert(!r.expense, 'Trošak primke je već knjižen.');
  assert(num(r.total) > 0, 'Primka nema vrijednost — nema troška za knjižiti.');
  const own = await tx.expense.findFirst({
    where: { companyId: actor.companyId, source: 'SUPPLIER_INVOICE', supplierInvoice: { OR: [{ receiptId: r.id }, ...(r.orderId ? [{ orderId: r.orderId }] : [])] } },
    select: { supplierInvoice: { select: { internalNo: true } } },
  });
  if (own) throw new DomainError(`Roba je već knjižena kao trošak ulaznog računa ${own.supplierInvoice?.internalNo ?? ''} — trošak se ne knjiži dvaput.`);
  const company = await tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { vatRate: true, country: true } });
  const total = r2(num(r.total));
  const rate = supplierVat(r.supplier?.country, { vatRate: num(company.vatRate), country: company.country }).rate;
  await tx.expense.create({
    data: {
      companyId: actor.companyId,
      date: r.date,
      categoryId: await expenseCategoryId(tx, actor.companyId, PURCHASE_CATEGORY),
      description: `Nabava robe — primka ${r.number}`,
      partnerId: r.supplierId,
      netAmount: total,
      vatAmount: r2((total * rate) / 100),
      source: 'RECEIPT',
      receiptId: r.id,
      createdBy: actor.name,
    },
  });
  // povezani ulazni račun više ne smije imati vlastiti trošak (ne bi ga ni trebao imati — provjera iznad)
  await audit(tx, actor, { entity: 'receipt', entityId: r.id, action: 'book', summary: `Primka ${r.number}: knjižen trošak nabave ${total.toFixed(2)} €` });
  return { total };
}
