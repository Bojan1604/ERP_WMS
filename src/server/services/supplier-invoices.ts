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
import { type InvoiceExpenseMode } from '@/domain/purchase-links';
import { countLabel, plural } from '@/domain/plural';
import {
  COVERING_GOODS_INVOICE, goodsGroupOf, goodsInvoiceContext, linkedReceiptIds, lockPurchaseDocs, mirrorReceiptPaid, paidGoodsInvoiceDate, reconcileOrderGoodsExpense,
} from './goods-expense';

// =============================================================================
//  Ulazni računi (knjiga URA): upis, veza s narudžbenicom/primkom, trošak.
//  Trošak robe po narudžbenici = max(primke, računi za robu) — usklađivanje
//  `reconcileOrderGoodsExpense` (goods-expense.ts) nakon svake promjene.
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
  /**
   * „Ovo je račun za robu s primke": trošak robe nosi primka, račun ga ne knjiži.
   * undefined/null = zadano pravilo (iznos ≈ vrijednost robe i prvi povezani račun).
   */
  goods?: boolean | null;
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

/**
 * Odluke računa o trošku i usklađivanje: `book` = „Knjiži kao trošak" (pamti se), `goods` =
 * „račun za robu" (undefined/null = spremljena odluka, a bez nje zadano pravilo — odluka se
 * pamti uz povezani račun). Koliko račun stvarno knjiži određuje pravilo skupine
 * (`reconcileOrderGoodsExpense`): cijelu osnovicu, samo razliku iznad primki ili ništa.
 * Plaćenost računa za robu prelazi na troškove primki. Zaprimljeni eRačun i odbijeni ne knjiže ništa.
 * `prevPaid` = datum plaćanja prije izmjene (poništavanje plaćenosti prenesene na primke).
 */
export async function applyInvoiceExpense(
  tx: Tx,
  actor: Actor,
  id: string,
  book: boolean,
  opts: { goods?: boolean | null; prevPaid?: Date | null } = {},
): Promise<InvoiceExpenseMode> {
  const si = await tx.supplierInvoice.findFirst({
    where: { id, companyId: actor.companyId },
    select: { id: true, orderId: true, receiptId: true, netAmount: true, category: true, paidDate: true, goodsInvoice: true, bookExpense: true },
  });
  assert(si, 'Ulazni račun ne postoji.');
  await lockPurchaseDocs(tx, actor.companyId, { orderId: si.orderId, receiptIds: si.receiptId ? [si.receiptId] : [] });
  const linked = !!(si.orderId || si.receiptId);
  const ctx = linked
    ? await goodsInvoiceContext(tx, actor.companyId, { id: si.id, orderId: si.orderId, receiptId: si.receiptId, netAmount: num(si.netAmount), category: si.category })
    : null;
  const goods = !!ctx && (opts.goods ?? si.goodsInvoice ?? ctx.defaultGoods);
  // odluke se pamte (prihvaćanje eRačuna, „Knjiži ponovno", plaćenost i usklađivanje ih poštuju)
  const stored = linked ? goods : null;
  if (stored !== si.goodsInvoice || book !== si.bookExpense) {
    await tx.supplierInvoice.update({ where: { id: si.id }, data: { goodsInvoice: stored, bookExpense: book } });
  }
  const modes = await reconcileOrderGoodsExpense(tx, actor, { orderId: si.orderId, receiptId: si.receiptId, invoiceId: si.id });
  const mode = modes.get(si.id) ?? 'none';
  if (ctx && (mode === 'receipt' || mode === 'partial')) await mirrorReceiptPaid(tx, actor.companyId, ctx.receipts, opts.prevPaid ?? null, si.paidDate);
  return mode;
}

/**
 * Narudžbenica i primka za vezu s računom — moraju biti firme i istog dobavljača.
 * Nova veza traži proknjiženu primku; postojeća veza sa storniranom primkom ostaje (trag).
 */
async function resolveLinks(tx: Tx, actor: Actor, supplierId: string, orderId: string | null, receiptId: string | null, currentReceiptId: string | null = null) {
  let oid = orderId;
  if (receiptId) {
    const r = await tx.goodsReceipt.findFirst({ where: { id: receiptId, companyId: actor.companyId }, select: { id: true, number: true, supplierId: true, orderId: true, status: true } });
    assert(r, 'Primka ne postoji.');
    assert(r.status === 'POSTED' || receiptId === currentReceiptId, `Primka ${r.number} je stornirana.`);
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
    old?.receiptId ?? null,
  );
  const net = r2(input.netAmount);
  const vat = r2(input.vatAmount);
  const total = input.total ? r2(input.total) : r2(net + vat);
  // odluka „račun za robu": izričita s obrasca; bez nje ostaje spremljena dok se veza ne promijeni,
  // a za novu vezu / novi račun odlučuje pravilo iznosa po STVARNO upisanoj osnovici
  const sameLinks = !!old && old.orderId === links.orderId && old.receiptId === links.receiptId;
  const goodsInvoice = typeof input.goods === 'boolean' ? input.goods : sameLinks ? undefined : null;
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
    ...(goodsInvoice !== undefined ? { goodsInvoice } : {}),
  };

  let si: { id: string; internalNo: string };
  if (id && old) {
    await tx.supplierInvoice.update({ where: { id }, data });
    si = { id: old.id, internalNo: old.internalNo };
  } else {
    const internalNo = await nextDocNumber(tx, actor.companyId, 'SUPPLIER_INVOICE', Number(input.issueDate.slice(0, 4)));
    si = await tx.supplierInvoice.create({ data: { companyId: actor.companyId, internalNo, ...data }, select: { id: true, internalNo: true } });
  }

  const mode = await applyInvoiceExpense(tx, actor, si.id, input.book, { prevPaid: old?.paidDate ?? null });
  // račun je premješten s druge narudžbenice/primke — i stara skupina se usklađuje (njeni računi opet knjiže robu)
  if (old && !sameLinks && (old.orderId || old.receiptId)) {
    const prev = await goodsGroupOf(tx, actor.companyId, old);
    const next = await goodsGroupOf(tx, actor.companyId, links);
    if (prev && JSON.stringify(prev) !== JSON.stringify(next)) await reconcileOrderGoodsExpense(tx, actor, old);
  }

  await audit(tx, actor, {
    entity: 'supplierInvoice',
    entityId: si.id,
    action: id ? 'update' : 'create',
    summary:
      `Ulazni račun ${si.internalNo} (${number}, ${supplier.name}) ${id ? 'izmijenjen' : 'upisan'}` +
      (supplier.created ? ' — otvoren novi dobavljač' : '') +
      (mode === 'receipt' ? ' — trošak robe knjižen primkom' : mode === 'partial' ? ' — knjižena razlika iznad primke' : ''),
  });
  // eRačun koji je ovim spremanjem postao plaćen javlja se posredniku (nakon transakcije)
  const newlyPaid = old?.source === 'EINVOICE' && !old.paidDate && !!data.paidDate;
  return { ...si, newlyPaid, eInvoiceId: old?.eInvoiceId ?? null, mode, supplierCreated: supplier.created };
}

export async function setSupplierInvoicesPaid(tx: Tx, actor: Actor, ids: string[], paidDate: string | null) {
  const found = await tx.supplierInvoice.findMany({
    where: { id: { in: ids }, companyId: actor.companyId },
    select: { id: true, status: true, source: true, internalNo: true, orderId: true, receiptId: true, paidDate: true, goodsInvoice: true, bookExpense: true },
  });
  assert(found.length === ids.length, 'Neki računi ne postoje.');
  const rejected = found.filter((f) => f.status === 'REJECTED');
  assert(!paidDate || !rejected.length, `Odbijeni računi se ne mogu označiti plaćenima: ${rejected.map((r) => r.internalNo).slice(0, 10).join(', ')}`);
  const pending = found.filter((f) => f.source === 'EINVOICE' && f.status === 'RECEIVED');
  assert(!paidDate || !pending.length, `Zaprimljene eRačune prvo prihvatite, pa ih onda označite plaćenima: ${pending.map((r) => r.internalNo).slice(0, 10).join(', ')}`);
  const d = paidDate ? fromISO(paidDate) : null;
  await tx.supplierInvoice.updateMany({ where: { id: { in: ids }, companyId: actor.companyId }, data: { paidDate: d } });
  await tx.expense.updateMany({ where: { supplierInvoiceId: { in: ids }, companyId: actor.companyId }, data: { paid: !!d, paidDate: d } });
  // račun za robu koji troši trošak primki: plaćenost prelazi na trošak nabave s povezanih primki — i poništavanje
  for (const f of found) {
    if (!f.goodsInvoice || !f.bookExpense || f.status !== COVERING_GOODS_INVOICE.status) continue;
    await mirrorReceiptPaid(tx, actor.companyId, await linkedReceiptIds(tx, actor.companyId, f), f.paidDate, d);
  }
  await audit(tx, actor, {
    entity: 'supplierInvoice',
    action: d ? 'paid' : 'unpaid',
    summary: `${countLabel(ids.length, 'ulazni račun', 'ulazna računa', 'ulaznih računa')} ${plural(ids.length, 'označen', 'označena', 'označeno')} kao ${d ? `plaćeno (${paidDate})` : 'neplaćeno'}`,
  });
  return ids.length;
}

export async function deleteSupplierInvoice(tx: Tx, actor: Actor, id: string) {
  const si = await tx.supplierInvoice.findFirst({
    where: { id, companyId: actor.companyId },
    select: { id: true, internalNo: true, number: true, source: true, status: true, orderId: true, receiptId: true, supplierId: true },
  });
  assert(si, 'Ulazni račun ne postoji.');
  // prihvaćen/odbijen eRačun je javljen posredniku (i Poreznoj upravi) — zapis ostaje
  assert(si.source !== 'EINVOICE' || si.status === 'RECEIVED', `eRačun ${si.internalNo} koji je prihvaćen ili odbijen kod posrednika se ne briše.`);
  await tx.expense.deleteMany({ where: { supplierInvoiceId: id, companyId: actor.companyId } });
  await tx.attachment.deleteMany({ where: { companyId: actor.companyId, entity: 'supplierInvoice', entityId: id } });
  await tx.supplierInvoice.delete({ where: { id } });
  // račun nastao iz podataka računa na narudžbenici: brišu se i ti podaci, inače bi ga sljedeća primka ponovno stvorila
  const cleared = si.orderId
    ? await tx.purchaseOrder.updateMany({
        where: { id: si.orderId, companyId: actor.companyId, supplierId: si.supplierId, supplierInvoiceNo: si.number },
        data: {
          supplierInvoiceNo: null, supplierInvoiceDate: null, supplierInvoiceDueDate: null, supplierInvoiceCurrency: null,
          supplierInvoiceNet: null, supplierInvoiceVat: null, supplierInvoiceTotal: null,
        },
      })
    : { count: 0 };
  // drugi računi iste narudžbenice sada možda moraju knjižiti robu (max(primke, računi za robu))
  if (si.orderId || si.receiptId) await reconcileOrderGoodsExpense(tx, actor, { orderId: si.orderId, receiptId: si.receiptId });
  await audit(tx, actor, {
    entity: 'supplierInvoice',
    entityId: id,
    action: 'delete',
    summary: `Ulazni račun ${si.internalNo} (${si.number}) obrisan${cleared.count ? ' — obrisani i podaci računa na narudžbenici' : ''}`,
  });
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
 * „Knjiži ponovno": račun nije knjižen („Knjiži kao trošak" isključen) — uključuje se i
 * knjiži po pravilu skupine (ako robu nose primke, ništa se ne stvara).
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
    summary:
      mode === 'own'
        ? `Ulazni račun ${si.internalNo} ponovno knjižen kao trošak`
        : mode === 'partial'
          ? `Ulazni račun ${si.internalNo}: knjižena razlika iznad primke`
          : `Ulazni račun ${si.internalNo}: trošak robe je knjižen primkom`,
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
  return syncOrderSupplierInvoice(tx, actor, orderId, { strict: true });
}

/**
 * Račun dobavljača s narudžbenice postaje ulazni račun (povezan s narudžbenicom)
 * čim je roba barem djelomično zaprimljena — tako ga vidi knjigovođa. Postojeći
 * račun istog dobavljača i broja se ažurira (eRačun se samo povezuje); drugi računi
 * narudžbenice (prijevoz i sl.) se ne diraju. To je račun za robu (trošak po pravilu
 * max(primke, računi za robu)), a izbor „ne knjiži" postojećeg računa se poštuje.
 * Novi račun mora stati u još nefakturiranu vrijednost robe — inače bi uz već upisan
 * račun za istu robu trošak robe narastao (dvaput fakturirana roba).
 * `strict`: sukob (drugi račun za istu robu, račun tog broja na drugoj narudžbenici) je
 * greška; inače se račun ne stvara.
 */
export async function syncOrderSupplierInvoice(tx: Tx, actor: Actor, orderId: string, opts: { strict?: boolean } = {}) {
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
  if (!o.supplierInvoiceNo) return null;
  const existing = await tx.supplierInvoice.findFirst({
    where: { companyId: actor.companyId, supplierId: o.supplierId, number: o.supplierInvoiceNo },
    select: { id: true, source: true, internalNo: true, orderId: true, order: { select: { number: true } }, bookExpense: true },
  });
  if (existing?.orderId && existing.orderId !== o.id) {
    if (opts.strict) throw new DomainError(`Račun ${o.supplierInvoiceNo} tog dobavljača već je upisan (${existing.internalNo}) i povezan s narudžbenicom ${existing.order?.number ?? ''}.`);
    return null;
  }
  const net = o.supplierInvoiceNet === null ? r2(num(o.total)) : r2(num(o.supplierInvoiceNet));
  const vat = o.supplierInvoiceVat === null ? 0 : r2(num(o.supplierInvoiceVat));
  if (!existing) {
    // drugi računi za robu iste narudžbenice: novi mora stati u nefakturirano (djelomični račun)
    const ctx = await goodsInvoiceContext(tx, actor.companyId, { id: null, orderId: o.id, receiptId: null, netAmount: net, category: PURCHASE_CATEGORY });
    if (ctx.otherGoodsInvoices > 0 && !ctx.defaultGoods) {
      if (!opts.strict) return null;
      const value = Math.max(...ctx.refs);
      throw new DomainError(
        `Narudžbenica već ima račun za robu (${ctx.otherGoodsNet.toFixed(2)} € od ${value.toFixed(2)} €) — račun ${o.supplierInvoiceNo} ` +
          `(${net.toFixed(2)} €) premašuje nefakturiranu vrijednost robe (${Math.max(0, r2(value - ctx.otherGoodsNet)).toFixed(2)} €). ` +
          'Upišite osnovicu djelomičnog računa ili upišite broj već upisanog računa.',
      );
    }
  }
  if (!o.receipts.length) return null;
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
  // novi račun se knjiži po pravilu; postojeći zadržava izbor „Knjiži kao trošak"
  let book = true;
  if (existing) {
    id = existing.id;
    book = existing.bookExpense;
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
  // račun s narudžbenice je račun za robu; zaprimljeni eRačun se ovdje ne knjiži (knjiži se prihvaćanjem)
  await applyInvoiceExpense(tx, actor, id, book, { goods: true });
  return id;
}

/**
 * Knjiženje troška primke naknadno (zaprimljeno bez knjiženja) — primka knjiži svoju
 * nabavnu vrijednost, a računi za robu iste narudžbenice se usklađuju (knjiže samo razliku
 * iznad primki), pa se roba ne knjiži dvaput.
 */
export async function bookReceiptExpense(tx: Tx, actor: Actor, receiptId: string) {
  const r = await tx.goodsReceipt.findFirst({
    where: { id: receiptId, companyId: actor.companyId },
    select: { id: true, number: true, date: true, status: true, total: true, orderId: true, supplierId: true, supplier: { select: { country: true } }, expense: { select: { id: true } } },
  });
  assert(r, 'Primka ne postoji.');
  assert(r.status === 'POSTED', 'Stornirana primka se ne knjiži.');
  assert(num(r.total) > 0, 'Primka nema vrijednost — nema troška za knjižiti.');
  await lockPurchaseDocs(tx, actor.companyId, { orderId: r.orderId, receiptIds: [r.id] });
  // ponovno pod zaključavanjem: istovremeno knjiženje iste primke
  const booked = await tx.expense.count({ where: { companyId: actor.companyId, receiptId: r.id } });
  assert(!r.expense && !booked, 'Trošak primke je već knjižen.');
  const company = await tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { vatRate: true, country: true } });
  const total = r2(num(r.total));
  const rate = supplierVat(r.supplier?.country, { vatRate: num(company.vatRate), country: company.country }).rate;
  // plaćen račun za tu robu — i trošak primke je plaćen
  const paidDate = await paidGoodsInvoiceDate(tx, actor.companyId, { orderId: r.orderId, receiptId: r.id });
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
      paid: !!paidDate,
      paidDate,
      createdBy: actor.name,
    },
  });
  // računi za robu skupine sada knjiže samo razliku iznad primki
  await reconcileOrderGoodsExpense(tx, actor, { orderId: r.orderId, receiptId: r.id });
  await audit(tx, actor, { entity: 'receipt', entityId: r.id, action: 'book', summary: `Primka ${r.number}: knjižen trošak nabave ${total.toFixed(2)} €` });
  return { total };
}
