import 'server-only';
import type { Tx } from '../db';
import { audit } from '../audit';
import type { Actor } from './items';
import { num, r2 } from '@/domain/money';
import { allocateGoodsExpense, defaultGoodsInvoice, type GoodsInvoiceRow, type InvoiceExpenseMode } from '@/domain/purchase-links';

// =============================================================================
//  Trošak robe u nabavi — JEDNO pravilo po narudžbenici (pravilo i dokaz: domain/purchase-links.ts,
//  opis: docs/RAZVOJ.md → „Trošak robe u nabavi").
//
//  Ukupni knjiženi trošak robe narudžbenice = max(troškovi primki, računi za robu) — nikad zbroj.
//  `reconcileOrderGoodsExpense` iz trenutnog stanja baze ponovno izračuna i zapiše vlastiti
//  trošak SVIH ulaznih računa skupine (troškove primki ne dira). Zove se nakon svake promjene:
//    • primka (receiveGoods), storno primke (cancelReceipt), naknadno knjiženje troška primke
//    • spremanje / povezivanje / promjena veze / brisanje ulaznog računa (i stare skupine)
//    • prihvaćanje i odbijanje eRačuna, „Knjiži ponovno", podaci računa na narudžbenici
//  Rezultat zato ne ovisi o redoslijedu radnji (vidi tests/integration/b-goods-expense.test.ts).
// =============================================================================

/** Skupina troška robe: narudžbenica, primka bez narudžbenice ili nepovezani račun. */
export type GoodsGroup = { orderId: string } | { receiptId: string } | { invoiceId: string };

/**
 * Zaključavanje narudžbenice/primki (FOR UPDATE) prije odluke o trošku robe — zaprimanje
 * i povezivanje računa istovremeno ne smiju oba knjižiti trošak (READ COMMITTED).
 */
export async function lockPurchaseDocs(tx: Tx, companyId: string, a: { orderId?: string | null; receiptIds?: string[] }) {
  if (a.orderId) await tx.$queryRaw`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${a.orderId} AND "companyId" = ${companyId} FOR UPDATE`;
  const rids = [...new Set(a.receiptIds ?? [])].sort();
  if (rids.length) await tx.$queryRaw`SELECT "id" FROM "GoodsReceipt" WHERE "id" = ANY(${rids}) AND "companyId" = ${companyId} ORDER BY "id" FOR UPDATE`;
}

/** Primke povezane s računom: izravno ili sve proknjižene primke povezane narudžbenice. */
export async function linkedReceiptIds(tx: Tx, companyId: string, si: { orderId: string | null; receiptId: string | null }) {
  const ids = new Set<string>();
  if (si.receiptId) ids.add(si.receiptId);
  if (si.orderId) {
    const rs = await tx.goodsReceipt.findMany({ where: { companyId, orderId: si.orderId, status: 'POSTED' }, select: { id: true } });
    for (const r of rs) ids.add(r.id);
  }
  return [...ids];
}

/** Skupina za vezu (narudžbenica ima prednost; primka s narudžbenicom pripada narudžbenici). */
export async function goodsGroupOf(tx: Tx, companyId: string, a: { orderId?: string | null; receiptId?: string | null; invoiceId?: string | null }): Promise<GoodsGroup | null> {
  if (a.orderId) return { orderId: a.orderId };
  if (a.receiptId) {
    const r = await tx.goodsReceipt.findFirst({ where: { id: a.receiptId, companyId }, select: { orderId: true } });
    if (r?.orderId) return { orderId: r.orderId };
    if (r) return { receiptId: a.receiptId };
  }
  return a.invoiceId ? { invoiceId: a.invoiceId } : null;
}

const invoiceSelect = {
  id: true, internalNo: true, number: true, status: true, issueDate: true, netAmount: true, vatAmount: true, paidDate: true, category: true, note: true,
  goodsInvoice: true, bookExpense: true, orderId: true, receiptId: true,
  supplier: { select: { id: true, name: true } },
  expense: { select: { id: true, netAmount: true, vatAmount: true } },
} as const;

/**
 * Stanje skupine iz baze (samo čitanje): troškovi proknjiženih primki (R) i računi redom
 * (datum računa, upis). Isto čitanje koristi usklađivanje i prikaz (narudžbenica, račun).
 */
export async function loadGoodsGroup(tx: Tx, companyId: string, group: GoodsGroup) {
  const receipts =
    'orderId' in group
      ? await tx.goodsReceipt.findMany({ where: { companyId, orderId: group.orderId, status: 'POSTED' }, select: { id: true } })
      : 'receiptId' in group
        ? await tx.goodsReceipt.findMany({ where: { companyId, id: group.receiptId, status: 'POSTED' }, select: { id: true } })
        : [];
  const receiptIds = receipts.map((r) => r.id);
  const [booked, invoices] = await Promise.all([
    receiptIds.length ? tx.expense.aggregate({ where: { companyId, receiptId: { in: receiptIds } }, _sum: { netAmount: true }, _count: { _all: true } }) : null,
    tx.supplierInvoice.findMany({
      where:
        'orderId' in group
          ? { companyId, OR: [{ orderId: group.orderId }, ...(receiptIds.length ? [{ receiptId: { in: receiptIds } }] : [])] }
          : 'receiptId' in group
            ? { companyId, receiptId: group.receiptId, orderId: null }
            : { companyId, id: group.invoiceId },
      orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: invoiceSelect,
    }),
  ]);
  const linked = !('invoiceId' in group);
  const rows: GoodsInvoiceRow[] = invoices.map((i) => ({
    id: i.id,
    net: num(i.netAmount),
    vat: num(i.vatAmount),
    goods: linked && i.goodsInvoice === true,
    books: i.status === 'ACCEPTED' && i.bookExpense,
  }));
  return { receiptIds, receiptExpenses: booked?._count._all ?? 0, receiptsBooked: r2(num(booked?._sum.netAmount ?? 0)), invoices, rows };
}

/** Pravilo nad stanjem skupine (bez pisanja) — za prikaz. */
export async function goodsExpensePlan(tx: Tx, companyId: string, group: GoodsGroup) {
  const g = await loadGoodsGroup(tx, companyId, group);
  return { ...g, allocation: allocateGoodsExpense(g.receiptsBooked, g.rows) };
}

/**
 * Usklađivanje troška robe skupine (narudžbenice) po pravilu max(primke, računi za robu):
 * vlastiti trošak svakog ulaznog računa skupine se stvara, mijenja ili briše tako da
 * odgovara pravilu. Troškovi primki se ne mijenjaju. Vraća način za svaki račun.
 */
export async function reconcileOrderGoodsExpense(tx: Tx, actor: Actor, ref: { orderId?: string | null; receiptId?: string | null; invoiceId?: string | null }) {
  const modes = new Map<string, InvoiceExpenseMode>();
  const group = await goodsGroupOf(tx, actor.companyId, ref);
  if (!group) return modes;
  if ('orderId' in group) await lockPurchaseDocs(tx, actor.companyId, { orderId: group.orderId });
  if ('receiptId' in group) await lockPurchaseDocs(tx, actor.companyId, { receiptIds: [group.receiptId] });
  const g = await loadGoodsGroup(tx, actor.companyId, group);
  const alloc = allocateGoodsExpense(g.receiptsBooked, g.rows);
  const changed: string[] = [];
  for (const [k, si] of g.invoices.entries()) {
    const a = alloc[k];
    modes.set(si.id, a.mode);
    const cur = si.expense ? { net: num(si.expense.netAmount), vat: num(si.expense.vatAmount) } : null;
    if (a.ownNet === 0 && a.ownVat === 0) {
      if (cur) {
        await tx.expense.deleteMany({ where: { supplierInvoiceId: si.id, companyId: actor.companyId } });
        changed.push(`${si.internalNo} bez vlastitog troška`);
      }
      continue;
    }
    const expense = {
      date: si.issueDate,
      categoryId: si.category ? await categoryId(tx, actor.companyId, si.category) : null,
      description: `Ulazni račun ${si.number} — ${si.supplier.name}${a.mode === 'partial' ? ' (razlika iznad primke)' : ''}`,
      partnerId: si.supplier.id,
      netAmount: a.ownNet,
      vatAmount: a.ownVat,
      paid: !!si.paidDate,
      paidDate: si.paidDate,
      note: si.note ?? null,
    };
    await tx.expense.upsert({
      where: { supplierInvoiceId: si.id },
      update: expense,
      create: { companyId: actor.companyId, ...expense, source: 'SUPPLIER_INVOICE', supplierInvoiceId: si.id, createdBy: actor.name },
    });
    if (!cur || cur.net !== a.ownNet || cur.vat !== a.ownVat) changed.push(`${si.internalNo} ${a.ownNet.toFixed(2)}`);
  }
  // trag usklađivanja kad se promijenio trošak računa (drugi dokument skupine je promijenio stanje)
  if (changed.length && !('invoiceId' in group)) {
    await audit(tx, actor, {
      entity: 'orderId' in group ? 'purchaseOrder' : 'receipt',
      entityId: 'orderId' in group ? group.orderId : group.receiptId,
      action: 'reconcile',
      summary: `Usklađen trošak robe (primke ${g.receiptsBooked.toFixed(2)} €): ${changed.join(', ')}`,
    });
  }
  return modes;
}

async function categoryId(tx: Tx, companyId: string, name: string) {
  const c = await tx.expenseCategory.upsert({ where: { companyId_name: { companyId, name } }, update: {}, create: { companyId, name }, select: { id: true } });
  return c.id;
}

/**
 * Stanje veze računa s robom: povezane primke, njihov trošak, vrijednosti robe (zbroj primki,
 * narudžbenica) i drugi povezani računi za robu (neodbijeni s odlukom `goodsInvoice`). Daje
 * i zadanu kvačicu „račun za robu" (obrazac je preračunava iz upisane osnovice i kategorije).
 */
export async function goodsInvoiceContext(
  tx: Tx,
  companyId: string,
  si: { id: string | null; orderId: string | null; receiptId: string | null; netAmount: number; category?: string | null },
) {
  const receipts = await linkedReceiptIds(tx, companyId, si);
  if (!receipts.length && !si.orderId) {
    return { receipts, receiptExpenses: 0, defaultGoods: false, refs: [] as number[], otherGoodsInvoices: 0, otherGoodsNet: 0 };
  }
  const [receiptExpenses, sums, order, others] = await Promise.all([
    receipts.length ? tx.expense.count({ where: { companyId, receiptId: { in: receipts } } }) : 0,
    receipts.length ? tx.goodsReceipt.aggregate({ where: { companyId, id: { in: receipts }, status: 'POSTED' }, _sum: { total: true } }) : null,
    si.orderId ? tx.purchaseOrder.findFirst({ where: { id: si.orderId, companyId }, select: { total: true } }) : null,
    tx.supplierInvoice.aggregate({
      where: {
        companyId,
        ...(si.id ? { id: { not: si.id } } : {}),
        status: { not: 'REJECTED' },
        goodsInvoice: true,
        OR: [...(si.orderId ? [{ orderId: si.orderId }] : []), ...(receipts.length ? [{ receiptId: { in: receipts } }] : [])],
      },
      _count: { _all: true },
      _sum: { netAmount: true },
    }),
  ]);
  const refs = [num(sums?._sum.total ?? 0), order ? num(order.total) : 0];
  const otherGoodsInvoices = others._count._all;
  const otherGoodsNet = r2(num(others._sum.netAmount ?? 0));
  return {
    receipts,
    receiptExpenses,
    defaultGoods: defaultGoodsInvoice({ net: si.netAmount, category: si.category ?? null, refs, otherGoodsNet, otherGoodsInvoices }),
    refs,
    otherGoodsInvoices,
    otherGoodsNet,
  };
}

/**
 * Plaćenost računa za robu prelazi na troškove nabave s primki: plaćanje označava
 * neplaćene (i one plaćene prijašnjim datumom računa), poništavanje vraća samo one
 * čiji je datum plaćanja došao s računa.
 */
export async function mirrorReceiptPaid(tx: Tx, companyId: string, receipts: string[], prevPaid: Date | null, paid: Date | null) {
  if (!receipts.length) return;
  if (!paid && !prevPaid) return;
  const fromInvoice = prevPaid ? [{ paid: true, paidDate: prevPaid }] : [];
  if (paid) {
    await tx.expense.updateMany({ where: { companyId, receiptId: { in: receipts }, OR: [{ paid: false }, ...fromInvoice] }, data: { paid: true, paidDate: paid } });
  } else if (prevPaid) {
    await tx.expense.updateMany({ where: { companyId, receiptId: { in: receipts }, paid: true, paidDate: prevPaid }, data: { paid: false, paidDate: null } });
  }
}

/** Račun za robu koji troši trošak primki (plaćenost mu prelazi na primke): prihvaćen, knjiži se. */
export const COVERING_GOODS_INVOICE = { status: 'ACCEPTED', goodsInvoice: true, bookExpense: true } as const;

/**
 * Plaćen račun za robu povezan s narudžbenicom/primkom — trošak nove primke tada odmah
 * nosi njegov datum plaćanja.
 */
export async function paidGoodsInvoiceDate(tx: Tx, companyId: string, a: { orderId: string | null; receiptId: string }) {
  const si = await tx.supplierInvoice.findFirst({
    where: { companyId, ...COVERING_GOODS_INVOICE, paidDate: { not: null }, OR: [{ receiptId: a.receiptId }, ...(a.orderId ? [{ orderId: a.orderId }] : [])] },
    orderBy: { createdAt: 'asc' },
    select: { paidDate: true },
  });
  return si?.paidDate ?? null;
}

// =============================================================================
//  Jednokratno usklađivanje starih podataka (prije jednog pravila trošak robe se znao knjižiti
//  dvaput: primka + račun). Provjera dosljednosti (Postavke → Podaci) prikazuje odstupanja, a
//  popravak i jednokratni posao pri pokretanju nove verzije zovu reconcileOrderGoodsExpense.
// =============================================================================

type Reader = Pick<Tx, 'supplierInvoice' | 'goodsReceipt' | 'expense' | 'purchaseOrder'>;

/** Skupine s ulaznim računima: narudžbenice (i preko primki) te primke bez narudžbenice. */
type LinkedGroup = { orderId: string } | { receiptId: string };

async function goodsGroupsWithInvoices(tx: Reader, companyId: string): Promise<LinkedGroup[]> {
  const invs = await tx.supplierInvoice.findMany({
    where: { companyId, OR: [{ orderId: { not: null } }, { receiptId: { not: null } }] },
    select: { orderId: true, receipt: { select: { id: true, orderId: true } } },
  });
  const orders = new Set<string>();
  const receipts = new Set<string>();
  for (const i of invs) {
    if (i.orderId) orders.add(i.orderId);
    else if (i.receipt?.orderId) orders.add(i.receipt.orderId);
    else if (i.receipt) receipts.add(i.receipt.id);
  }
  return [...[...orders].sort().map((orderId): LinkedGroup => ({ orderId })), ...[...receipts].sort().map((receiptId): LinkedGroup => ({ receiptId }))];
}

export interface GoodsExpenseMismatch {
  group: LinkedGroup;
  /** Broj narudžbenice ili primke. */
  label: string;
  href: string;
  /** Zbroj vlastitih troškova računa skupine: sada i po pravilu. */
  booked: number;
  expected: number;
  /** Računi čiji se trošak mijenja: sadašnje stanje (za trag u dnevniku). */
  invoices: Array<{ internalNo: string; net: number; vat: number; invoicePaid: boolean; expectedNet: number; expectedVat: number }>;
}

/**
 * Skupine čiji vlastiti troškovi ulaznih računa ne odgovaraju pravilu max(primke, računi za robu)
 * — samo čitanje, isto stanje i pravilo kao reconcileOrderGoodsExpense.
 */
export async function goodsExpenseMismatches(tx: Reader, companyId: string): Promise<GoodsExpenseMismatch[]> {
  const out: GoodsExpenseMismatch[] = [];
  for (const group of await goodsGroupsWithInvoices(tx, companyId)) {
    const g = await loadGoodsGroup(tx as Tx, companyId, group);
    const alloc = allocateGoodsExpense(g.receiptsBooked, g.rows);
    const bad: GoodsExpenseMismatch['invoices'] = [];
    let booked = 0;
    let expected = 0;
    for (const [k, si] of g.invoices.entries()) {
      const a = alloc[k];
      const net = si.expense ? num(si.expense.netAmount) : 0;
      const vat = si.expense ? num(si.expense.vatAmount) : 0;
      booked += net;
      expected += a.ownNet;
      // trošak s iznosom 0 = kao nepostojeći (usklađivanje ga ionako briše)
      if (net !== a.ownNet || vat !== a.ownVat) {
        bad.push({ internalNo: si.internalNo, net, vat, invoicePaid: !!si.paidDate, expectedNet: a.ownNet, expectedVat: a.ownVat });
      }
    }
    if (!bad.length) continue;
    const ref =
      'orderId' in group
        ? await tx.purchaseOrder.findFirst({ where: { id: group.orderId, companyId }, select: { number: true } })
        : await tx.goodsReceipt.findFirst({ where: { id: group.receiptId, companyId }, select: { number: true } });
    out.push({
      group,
      label: ref?.number ?? '—',
      href: 'orderId' in group ? `/nabava/narudzbenice/${group.orderId}` : `/nabava/primke/${group.receiptId}`,
      booked: r2(booked),
      expected: r2(expected),
      invoices: bad,
    });
  }
  return out;
}

/**
 * Usklađuje sve skupine s odstupanjem. Svaka skupina dobiva zapis u dnevniku s prijašnjim
 * iznosima (i plaćenošću) troškova koji se mijenjaju. Idempotentno: drugi prolaz ne mijenja ništa.
 */
export async function reconcileAllGoodsExpenses(tx: Tx, actor: Actor): Promise<number> {
  const list = await goodsExpenseMismatches(tx, actor.companyId);
  for (const m of list) {
    await reconcileOrderGoodsExpense(tx, actor, m.group);
    await audit(tx, actor, {
      entity: 'orderId' in m.group ? 'purchaseOrder' : 'receipt',
      entityId: 'orderId' in m.group ? m.group.orderId : m.group.receiptId,
      action: 'goods-expense-fix',
      summary: `Usklađivanje troška robe (${m.label}): vlastiti troškovi računa ${m.booked.toFixed(2)} € → ${m.expected.toFixed(2)} €`,
      diff: { invoices: m.invoices },
    });
  }
  return list.length;
}
