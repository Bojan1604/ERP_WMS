/**
 * Trošak robe po narudžbenici — jedno pravilo (reconcileOrderGoodsExpense, services/goods-expense.ts):
 * ukupni trošak robe narudžbenice = max(troškovi primki, računi za robu), nikad zbroj; računi koji
 * nisu roba (prijevoz) uvijek zasebno. Matrica redoslijeda radnji: svaki redoslijed mora dati isti
 * ukupni trošak, a nakon SVAKOG koraka vrijedi nepromjenjivo pravilo nad stanjem baze.
 * Narudžbenica u svim scenarijima: 2 kom × 100 € = 200 €.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { Actor } from '../../src/server/services/items';
import { cancelReceipt, receiveGoods, saveOrder, setOrderStatus } from '../../src/server/services/purchasing';
import {
  bookReceiptExpense, deleteSupplierInvoice, rebookSupplierInvoice, saveOrderInvoice, saveSupplierInvoice, type SupplierInvoiceInput,
} from '../../src/server/services/supplier-invoices';
import { acceptSupplierInvoice, rejectSupplierInvoice } from '../../src/server/services/inbound';
import { goodsExpensePlan } from '../../src/server/services/goods-expense';
import { fromISO } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

let s: { companyId: string; actor: Actor; modelId: string; whId: string; supplierId: string };
let seq = 0;

before(async () => {
  const c = await db.company.create({ data: { name: `B-goods ${Date.now()}-${Math.random()}` } });
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `bg${Date.now()}${Math.random()}@t.hr`, name: 'Nabava', passwordHash: 'x', role: 'ADMIN' } });
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'V2' } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const supplier = await db.partner.create({ data: { companyId: c.id, name: 'Distributer d.o.o.', country: 'HR', isSupplier: true } });
  s = { companyId: c.id, actor: { id: u.id, name: u.name, companyId: c.id }, modelId: model.id, whId: wh.id, supplierId: supplier.id };
});

after(async () => {
  await db.user.deleteMany({ where: { companyId: s.companyId } });
  await db.purchaseOrder.deleteMany({ where: { companyId: s.companyId } });
  await db.company.delete({ where: { id: s.companyId } });
  await db.$disconnect();
});

// ---------------------------------------------------------------- pomoćnici

interface Ctx {
  tag: string;
  orderId: string;
  lineId: string;
  receipts: Record<string, string>;
  invoices: Record<string, string>;
}

async function newOrder(): Promise<Ctx> {
  const tag = `S${++seq}`;
  const o = await transaction((tx) => saveOrder(tx, s.actor, null, { supplierId: s.supplierId, date: '2026-05-01', lines: [{ modelId: s.modelId, qty: 2, unitCost: 100 }] }));
  await transaction((tx) => setOrderStatus(tx, s.actor, o.id, 'ORDERED'));
  const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { orderId: o.id } });
  return { tag, orderId: o.id, lineId: line.id, receipts: {}, invoices: {} };
}

const receive = (c: Ctx, key: string, qty: number, bookExpense = true) =>
  transaction((tx) =>
    receiveGoods(tx, s.actor, {
      orderId: c.orderId,
      warehouseId: s.whId,
      date: '2026-05-10',
      bookExpense,
      lines: [{ modelId: s.modelId, unitCost: 100, serials: Array.from({ length: qty }, (_, i) => `${c.tag}-${key}-${i}`), orderLineId: c.lineId }],
    }),
  ).then((r) => {
    c.receipts[key] = r.id;
    return r;
  });

const invoice = (c: Ctx, key: string, over: Partial<SupplierInvoiceInput> & { netAmount: number }) =>
  transaction((tx) =>
    saveSupplierInvoice(tx, s.actor, c.invoices[key] ?? null, {
      supplierId: s.supplierId,
      number: `${c.tag}-${key}`,
      issueDate: `2026-05-${String(10 + Object.keys(c.invoices).length).padStart(2, '0')}`,
      vatAmount: over.netAmount * 0.25,
      category: 'Nabava robe',
      orderId: c.orderId,
      book: true,
      ...over,
    }),
  ).then((r) => {
    c.invoices[key] = r.id;
    return r;
  });

/** Zaprimljeni eRačun (bez posrednika — prihvaća se samo u programu). */
async function pendingEInvoice(c: Ctx, key: string, net: number) {
  const si = await db.supplierInvoice.create({
    data: {
      companyId: s.companyId, internalNo: `URA-${c.tag}-${key}`, number: `${c.tag}-${key}`, supplierId: s.supplierId, issueDate: fromISO('2026-05-12'),
      netAmount: net, vatAmount: net * 0.25, total: net * 1.25, source: 'EINVOICE', status: 'RECEIVED', category: 'Nabava robe',
    },
  });
  c.invoices[key] = si.id;
}

const linkInvoice = (c: Ctx, key: string) =>
  db.supplierInvoice.findUniqueOrThrow({ where: { id: c.invoices[key] } }).then((si) =>
    transaction((tx) =>
      saveSupplierInvoice(tx, s.actor, si.id, {
        supplierId: s.supplierId, number: si.number, issueDate: '2026-05-12', netAmount: Number(si.netAmount), vatAmount: Number(si.vatAmount),
        category: si.category, orderId: c.orderId, book: true,
      }),
    ),
  );

const orderInvoiceData = (c: Ctx, no: string, net: number | null) =>
  transaction((tx) =>
    saveOrderInvoice(tx, s.actor, c.orderId, {
      supplierInvoiceNo: `${c.tag}-${no}`, supplierInvoiceDate: '2026-05-11', supplierInvoiceDueDate: null, supplierInvoiceCurrency: null,
      supplierInvoiceNet: net, supplierInvoiceVat: net === null ? null : net * 0.25, supplierInvoiceTotal: null,
    }),
  );

/** Troškovi narudžbenice: roba (primke + računi za robu) i ostalo (prijevoz). */
async function orderExpense(c: Ctx) {
  const rows = await db.expense.findMany({
    where: { companyId: s.companyId, OR: [{ receipt: { orderId: c.orderId } }, { supplierInvoice: { orderId: c.orderId } }] },
    select: { netAmount: true, source: true, supplierInvoice: { select: { goodsInvoice: true } } },
  });
  let goods = 0;
  let other = 0;
  for (const e of rows) {
    if (e.source === 'RECEIPT' || e.supplierInvoice?.goodsInvoice) goods += Number(e.netAmount);
    else other += Number(e.netAmount);
  }
  return { goods: Math.round(goods * 100) / 100, other: Math.round(other * 100) / 100 };
}

/** Nepromjenjivo pravilo nad stanjem baze: roba = max(R, I), ostalo = zbroj računa koji nisu roba. */
async function assertRule(c: Ctx, label: string) {
  const plan = await goodsExpensePlan(db, s.companyId, { orderId: c.orderId });
  const I = plan.rows.filter((r) => r.goods && r.books).reduce((a, r) => a + r.net, 0);
  const other = plan.rows.filter((r) => !r.goods && r.books).reduce((a, r) => a + r.net, 0);
  const got = await orderExpense(c);
  assert.equal(got.goods, Math.max(plan.receiptsBooked, Math.round(I * 100) / 100), `${label}: roba = max(R ${plan.receiptsBooked}, I ${I})`);
  assert.equal(got.other, other, `${label}: prijevoz zasebno`);
  return got;
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

type Op = { name: string; run: (c: Ctx) => Promise<unknown> };

/** Svaki redoslijed operacija: pravilo nakon svakog koraka i isti konačni trošak. */
async function matrix(ops: Op[], expected: { goods: number; other: number }, check?: (c: Ctx) => Promise<void>) {
  for (const order of permutations(ops)) {
    const c = await newOrder();
    const label = order.map((o) => o.name).join(' → ');
    for (const op of order) {
      await op.run(c);
      await assertRule(c, `${label} [nakon ${op.name}]`);
    }
    assert.deepEqual(await orderExpense(c), expected, label);
    if (check) await check(c);
  }
}

const P = (qty = 2, key = 'P'): Op => ({ name: `primka ${key}×${qty}`, run: (c) => receive(c, key, qty) });
const INV = (key: string, net: number, over: Partial<SupplierInvoiceInput> = {}): Op => ({ name: `račun ${key} ${net}`, run: (c) => invoice(c, key, { netAmount: net, ...over }) });
const FREIGHT: Op = { name: 'prijevoz 25', run: (c) => invoice(c, 'T', { netAmount: 25, category: 'Prijevoz' }) };

// ---------------------------------------------------------------- matrica

test('primka + dva djelomična računa (100 + 100) + prijevoz, svi redoslijedi → roba 200, prijevoz 25', async () => {
  await matrix([P(), INV('A', 100), INV('B', 100), FREIGHT], { goods: 200, other: 25 }, async (c) => {
    const inv = await db.supplierInvoice.findMany({ where: { id: { in: [c.invoices.A, c.invoices.B] } } });
    assert.ok(inv.every((i) => i.goodsInvoice === true), 'djelomični računi kategorije „Nabava robe" su zadano računi za robu');
    assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: c.invoices.T } })).goodsInvoice, false, 'prijevoz nije roba');
  });
});

test('primka + jedan račun za cijelu robu + prijevoz, svi redoslijedi → 200 + 25', async () => {
  await matrix([P(), INV('F', 200), FREIGHT], { goods: 200, other: 25 });
});

test('dvije djelomične primke + račun za cijelu robu, svi redoslijedi → 200', async () => {
  await matrix([P(1, 'P1'), P(1, 'P2'), INV('F', 200)], { goods: 200, other: 0 });
});

test('dvije djelomične primke + dva djelomična računa, svi redoslijedi → 200', async () => {
  await matrix([P(1, 'P1'), P(1, 'P2'), INV('A', 100), INV('B', 100)], { goods: 200, other: 0 });
});

test('račun viši od primke (250 prema 200), oba redoslijeda → 250 (razlika na računu)', async () => {
  // viši od nefakturirane vrijednosti — nije zadano roba, korisnik potvrđuje kvačicom
  await matrix([P(), INV('F', 250, { goods: true })], { goods: 250, other: 0 }, async (c) => {
    const e = await db.expense.findFirstOrThrow({ where: { supplierInvoiceId: c.invoices.F } });
    assert.equal(Number(e.netAmount), 50);
    assert.equal(Number(e.vatAmount), 12.5, 'PDV razmjerno razlici');
  });
});

test('eRačun: zaprimljen pa povezan pa prihvaćen, primka u svakom trenutku → 200', async () => {
  const E: Op = { name: 'eRačun zaprimljen', run: (c) => pendingEInvoice(c, 'E', 200) };
  const L: Op = { name: 'eRačun povezan', run: (c) => linkInvoice(c, 'E') };
  const A: Op = { name: 'eRačun prihvaćen', run: (c) => acceptSupplierInvoice(s.actor, c.invoices.E) };
  for (const pos of [0, 1, 2, 3]) {
    const c = await newOrder();
    const seqOps = [E, L, A];
    seqOps.splice(pos, 0, P());
    for (const op of seqOps) {
      await op.run(c);
      await assertRule(c, `eRačun, primka na mjestu ${pos} [nakon ${op.name}]`);
    }
    assert.deepEqual(await orderExpense(c), { goods: 200, other: 0 });
  }
});

test('eRačun: poruka prihvaćanja prema stvarnom knjiženju (N7)', async () => {
  const c = await newOrder();
  await receive(c, 'P', 2);
  await pendingEInvoice(c, 'E', 200);
  await linkInvoice(c, 'E');
  assert.equal((await acceptSupplierInvoice(s.actor, c.invoices.E)).mode, 'receipt', 'roba je na primci — račun ništa ne knjiži');
  const c2 = await newOrder();
  await pendingEInvoice(c2, 'E', 200);
  await linkInvoice(c2, 'E');
  assert.equal((await acceptSupplierInvoice(s.actor, c2.invoices.E)).mode, 'own');
  const c3 = await newOrder();
  await pendingEInvoice(c3, 'E', 200);
  assert.equal((await acceptSupplierInvoice(s.actor, c3.invoices.E, { book: false })).mode, 'none');
});

test('odbijen račun za robu više ne troši primku — drugi račun za robu se usklađuje', async () => {
  const c = await newOrder();
  await receive(c, 'P', 1);
  await invoice(c, 'A', { netAmount: 100 });
  await invoice(c, 'B', { netAmount: 100 });
  // A troši primku (100), B knjiži svojih 100 → max(100, 200) = 200
  assert.deepEqual(await assertRule(c, 'prije odbijanja'), { goods: 200, other: 0 });
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: c.invoices.B } }), 1);
  await rejectSupplierInvoice(s.actor, c.invoices.A, 'Pogrešan račun');
  // sada B troši primku → max(100, 100) = 100
  assert.deepEqual(await assertRule(c, 'nakon odbijanja'), { goods: 100, other: 0 });
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: c.invoices.B } }), 0);
});

test('podaci računa na narudžbenici: prije i poslije primke → 200 (N3)', async () => {
  await matrix([P(), { name: 'podaci računa 200', run: (c) => orderInvoiceData(c, 'PO', 200) }], { goods: 200, other: 0 });
  // uz djelomični račun: podaci računa za preostalih 100
  await matrix([P(), INV('A', 100), { name: 'podaci računa 100', run: (c) => orderInvoiceData(c, 'PO', 100) }], { goods: 200, other: 0 });
});

test('podaci računa na narudžbenici nakon već povezanog računa za cijelu robu se odbijaju (N3)', async () => {
  for (const receiptFirst of [false, true]) {
    const c = await newOrder();
    if (receiptFirst) await receive(c, 'P', 2);
    await invoice(c, 'H', { netAmount: 200 });
    await assert.rejects(orderInvoiceData(c, 'INV2', null), /već ima račun za robu/);
    if (!receiptFirst) await receive(c, 'P', 2);
    assert.deepEqual(await assertRule(c, 'H-INV'), { goods: 200, other: 0 });
    assert.equal(await db.supplierInvoice.count({ where: { orderId: c.orderId } }), 1);
    // isti broj kao postojeći račun — samo se povezuje
    await orderInvoiceData(c, 'H', null);
    assert.deepEqual(await assertRule(c, 'isti broj'), { goods: 200, other: 0 });
  }
});

test('storno primke i brisanje računa u svakom redoslijedu → trošak iz preostalih dokumenata', async () => {
  const STORNO: Op = { name: 'storno primke', run: (c) => transaction((tx) => cancelReceipt(tx, s.actor, c.receipts.P)) };
  const DEL: Op = { name: 'brisanje računa A', run: (c) => transaction((tx) => deleteSupplierInvoice(tx, s.actor, c.invoices.A)) };
  // primka prije storna, račun prije brisanja: ostaje samo račun B (100) + prijevoz
  for (const tail of permutations([STORNO, DEL])) {
    for (const head of permutations([P(), INV('A', 100), INV('B', 100), FREIGHT])) {
      const c = await newOrder();
      const label = [...head, ...tail].map((o) => o.name).join(' → ');
      for (const op of [...head, ...tail]) {
        await op.run(c);
        await assertRule(c, `${label} [nakon ${op.name}]`);
      }
      assert.deepEqual(await orderExpense(c), { goods: 100, other: 25 }, label);
    }
  }
});

test('račun pa primka, storno primke (račun sam opet knjiži) i ponovna primka → 200', async () => {
  const c = await newOrder();
  await invoice(c, 'F', { netAmount: 200 });
  await receive(c, 'P', 2);
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: c.invoices.F } }), 0);
  await transaction((tx) => cancelReceipt(tx, s.actor, c.receipts.P));
  assert.deepEqual(await assertRule(c, 'storno'), { goods: 200, other: 0 });
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: c.invoices.F } }), 1, 'račun sam knjiži (usklađivanje)');
  await receive(c, 'P2', 2);
  assert.deepEqual(await assertRule(c, 'ponovna primka'), { goods: 200, other: 0 });
});

test('primka bez knjiženja, račun, pa naknadno „Knjiži trošak" na primci → 200', async () => {
  for (const invoiceFirst of [false, true]) {
    const c = await newOrder();
    if (invoiceFirst) await invoice(c, 'F', { netAmount: 200 });
    const r = await receive(c, 'P', 2, false);
    assert.equal(r.booked, false);
    if (!invoiceFirst) await invoice(c, 'F', { netAmount: 200 });
    assert.deepEqual(await assertRule(c, 'primka bez troška'), { goods: 200, other: 0 });
    await transaction((tx) => bookReceiptExpense(tx, s.actor, c.receipts.P));
    assert.deepEqual(await assertRule(c, 'knjiženje primke'), { goods: 200, other: 0 });
    assert.equal(await db.expense.count({ where: { supplierInvoiceId: c.invoices.F } }), 0);
  }
});

test('račun bez knjiženja pa „Knjiži ponovno", u oba redoslijeda s primkom → 200', async () => {
  const OFF = INV('F', 200, { book: false });
  const REBOOK: Op = { name: 'knjiži ponovno', run: (c) => transaction((tx) => rebookSupplierInvoice(tx, s.actor, c.invoices.F)) };
  for (const order of [[P(), OFF, REBOOK], [OFF, P(), REBOOK], [OFF, REBOOK, P()]]) {
    const c = await newOrder();
    for (const op of order) {
      await op.run(c);
      await assertRule(c, order.map((o) => o.name).join(' → '));
    }
    assert.deepEqual(await orderExpense(c), { goods: 200, other: 0 });
  }
  // isključen račun uz primku: primka nosi robu, račun ništa
  const c = await newOrder();
  await invoice(c, 'F', { netAmount: 300, book: false });
  await receive(c, 'P', 2);
  assert.deepEqual(await orderExpense(c), { goods: 200, other: 0 });
});

test('premještanje računa na drugu narudžbenicu: obje skupine se usklađuju', async () => {
  const a = await newOrder();
  const b = await newOrder();
  await receive(a, 'P', 2);
  await invoice(a, 'F', { netAmount: 200 });
  assert.deepEqual(await orderExpense(a), { goods: 200, other: 0 });
  // račun prelazi na narudžbenicu b (bez primke) — ondje knjiži robu, a primka a i dalje svoju
  b.invoices.F = a.invoices.F;
  await invoice(b, 'F', { netAmount: 200, number: `${a.tag}-F`, goods: true });
  assert.deepEqual(await assertRule(a, 'a nakon premještanja'), { goods: 200, other: 0 });
  assert.deepEqual(await assertRule(b, 'b nakon premještanja'), { goods: 200, other: 0 });
  // i natrag
  await invoice(a, 'F', { netAmount: 200, goods: true });
  assert.deepEqual(await assertRule(a, 'a natrag'), { goods: 200, other: 0 });
  assert.deepEqual(await orderExpense(b), { goods: 0, other: 0 });
});

test('prijevoz označen kao „Nabava robe" ali ručno isključen kao roba ostaje zaseban trošak', async () => {
  await matrix([P(), INV('F', 200), INV('T', 25, { goods: false })], { goods: 200, other: 25 });
});
