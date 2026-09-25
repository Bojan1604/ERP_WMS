import 'server-only';
import { db, type Tx } from '../db';
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
 * — samo čitanje, isto stanje i pravilo kao reconcileOrderGoodsExpense (loadGoodsGroup), ali
 * skupno: nekoliko upita za cijelu firmu (ne po narudžbenici), pravilo se računa u memoriji.
 */
export async function goodsExpenseMismatches(tx: Reader, companyId: string): Promise<GoodsExpenseMismatch[]> {
  // svi povezani računi firme (redom kao u loadGoodsGroup) i skupina kojoj pripadaju
  const invs = await tx.supplierInvoice.findMany({
    where: { companyId, OR: [{ orderId: { not: null } }, { receiptId: { not: null } }] },
    orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, internalNo: true, status: true, netAmount: true, vatAmount: true, paidDate: true, goodsInvoice: true, bookExpense: true,
      orderId: true, receiptId: true, receipt: { select: { orderId: true } },
      expense: { select: { netAmount: true, vatAmount: true } },
    },
  });
  if (!invs.length) return [];
  const orderIds = new Set<string>();
  const loneReceipts = new Set<string>();
  for (const i of invs) {
    if (i.orderId) orderIds.add(i.orderId);
    else if (i.receipt?.orderId) orderIds.add(i.receipt.orderId);
    else if (i.receiptId && i.receipt) loneReceipts.add(i.receiptId);
  }
  // proknjižene primke skupina i njihovi troškovi (R)
  const receipts = await tx.goodsReceipt.findMany({
    where: { companyId, status: 'POSTED', OR: [{ orderId: { in: [...orderIds] } }, { id: { in: [...loneReceipts] } }] },
    select: { id: true, orderId: true },
  });
  const booked = receipts.length
    ? await tx.expense.groupBy({ by: ['receiptId'], where: { companyId, receiptId: { in: receipts.map((r) => r.id) } }, _sum: { netAmount: true } })
    : [];
  const bookedBy = new Map(booked.map((b) => [b.receiptId!, num(b._sum.netAmount ?? 0)]));
  const postedOrderOf = new Map(receipts.map((r) => [r.id, r.orderId]));
  const postedIds = new Set(receipts.map((r) => r.id));

  const key = (g: LinkedGroup) => ('orderId' in g ? `o:${g.orderId}` : `r:${g.receiptId}`);
  const groups = new Map<string, { group: LinkedGroup; receiptsBooked: number; invoices: typeof invs }>();
  const groupOf = (g: LinkedGroup) => {
    const k = key(g);
    let e = groups.get(k);
    if (!e) groups.set(k, (e = { group: g, receiptsBooked: 0, invoices: [] }));
    return e;
  };
  for (const id of [...orderIds].sort()) groupOf({ orderId: id });
  for (const id of [...loneReceipts].sort()) groupOf({ receiptId: id });
  for (const r of receipts) {
    const g = r.orderId && orderIds.has(r.orderId) ? groups.get(`o:${r.orderId}`) : loneReceipts.has(r.id) ? groups.get(`r:${r.id}`) : undefined;
    if (g) g.receiptsBooked = r2(g.receiptsBooked + (bookedBy.get(r.id) ?? 0));
  }
  // članstvo kao u loadGoodsGroup: narudžbenica = računi s njom ili s njenom proknjiženom primkom;
  // primka bez narudžbenice = računi s tom primkom bez narudžbenice
  for (const i of invs) {
    if (i.orderId) groupOf({ orderId: i.orderId }).invoices.push(i);
    else if (i.receiptId && postedIds.has(i.receiptId) && postedOrderOf.get(i.receiptId)) groupOf({ orderId: postedOrderOf.get(i.receiptId)! }).invoices.push(i);
    else if (i.receiptId && loneReceipts.has(i.receiptId)) groupOf({ receiptId: i.receiptId }).invoices.push(i);
  }

  const found: Array<Omit<GoodsExpenseMismatch, 'label' | 'href'>> = [];
  for (const g of groups.values()) {
    const rows: GoodsInvoiceRow[] = g.invoices.map((i) => ({
      id: i.id,
      net: num(i.netAmount),
      vat: num(i.vatAmount),
      goods: i.goodsInvoice === true,
      books: i.status === 'ACCEPTED' && i.bookExpense,
    }));
    const alloc = allocateGoodsExpense(g.receiptsBooked, rows);
    const bad: GoodsExpenseMismatch['invoices'] = [];
    let bookedSum = 0;
    let expected = 0;
    for (const [k, si] of g.invoices.entries()) {
      const a = alloc[k];
      const net = si.expense ? num(si.expense.netAmount) : 0;
      const vat = si.expense ? num(si.expense.vatAmount) : 0;
      bookedSum += net;
      expected += a.ownNet;
      // trošak s iznosom 0 = kao nepostojeći (usklađivanje ga ionako briše)
      if (net !== a.ownNet || vat !== a.ownVat) {
        bad.push({ internalNo: si.internalNo, net, vat, invoicePaid: !!si.paidDate, expectedNet: a.ownNet, expectedVat: a.ownVat });
      }
    }
    if (bad.length) found.push({ group: g.group, booked: r2(bookedSum), expected: r2(expected), invoices: bad });
  }
  if (!found.length) return [];
  // brojevi dokumenata samo za skupine s odstupanjem
  const oIds = found.flatMap((m) => ('orderId' in m.group ? [m.group.orderId] : []));
  const rIds = found.flatMap((m) => ('receiptId' in m.group ? [m.group.receiptId] : []));
  const [orders, lone] = await Promise.all([
    oIds.length ? tx.purchaseOrder.findMany({ where: { companyId, id: { in: oIds } }, select: { id: true, number: true } }) : [],
    rIds.length ? tx.goodsReceipt.findMany({ where: { companyId, id: { in: rIds } }, select: { id: true, number: true } }) : [],
  ]);
  const numberOf = new Map([...orders, ...lone].map((d) => [d.id, d.number]));
  return found.map((m) => ({
    ...m,
    label: numberOf.get('orderId' in m.group ? m.group.orderId : m.group.receiptId) ?? '—',
    href: 'orderId' in m.group ? `/nabava/narudzbenice/${m.group.orderId}` : `/nabava/primke/${m.group.receiptId}`,
  }));
}

/** Usklađivanje jedne skupine s odstupanjem uz trag u dnevniku (prijašnji iznosi i plaćenost). */
async function fixGoodsGroup(tx: Tx, actor: Actor, m: GoodsExpenseMismatch) {
  await reconcileOrderGoodsExpense(tx, actor, m.group);
  await audit(tx, actor, {
    entity: 'orderId' in m.group ? 'purchaseOrder' : 'receipt',
    entityId: 'orderId' in m.group ? m.group.orderId : m.group.receiptId,
    action: 'goods-expense-fix',
    summary: `Usklađivanje troška robe (${m.label}): vlastiti troškovi računa ${m.booked.toFixed(2)} € → ${m.expected.toFixed(2)} €`,
    diff: { invoices: m.invoices },
  });
}

/**
 * Popravak iz Postavke → Podaci: odstupanja se traže jednim skupnim čitanjem, a svaka skupina
 * se usklađuje u svojoj (kratkoj) transakciji — tisuće narudžbenica ne drže jednu dugu transakciju.
 */
export async function reconcileGoodsExpensesChunked(actor: Actor, run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>): Promise<number> {
  const list = await goodsExpenseMismatches(db, actor.companyId);
  for (const m of list) await run((tx) => fixGoodsGroup(tx, actor, m));
  return list.length;
}

/**
 * Usklađuje sve skupine s odstupanjem (u jednoj transakciji — jednokratni posao pri pokretanju).
 * Svaka skupina dobiva zapis u dnevniku s prijašnjim iznosima (i plaćenošću) troškova koji se
 * mijenjaju. Idempotentno: drugi prolaz ne mijenja ništa.
 */
export async function reconcileAllGoodsExpenses(tx: Tx, actor: Actor): Promise<number> {
  const list = await goodsExpenseMismatches(tx, actor.companyId);
  for (const m of list) await fixGoodsGroup(tx, actor, m);
  return list.length;
}
