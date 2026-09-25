/**
 * Područje E — ulazni račun ↔ narudžbenica/primka i pravilo „trošak robe se
 * knjiži jednom", slobodni unos dobavljača (automatski partner), skupno
 * brisanje i „Knjiži ponovno". Nad testnom bazom.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { Actor } from '../../src/server/services/items';
import { cancelReceipt, receiveGoods, saveOrder, setOrderStatus } from '../../src/server/services/purchasing';
import {
  bookReceiptExpense, deleteSupplierInvoices, rebookSupplierInvoice, saveOrderInvoice, saveSupplierInvoice, setSupplierInvoicesPaid,
} from '../../src/server/services/supplier-invoices';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup(tag: string) {
  const c = await db.company.create({ data: { name: `E-nab ${tag} ${Date.now()}-${Math.random()}` } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `en${tag}${Date.now()}${Math.random()}@t.hr`, name: 'Nabava E', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: `V2-${tag}` } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const supplier = await db.partner.create({ data: { companyId: c.id, name: 'Dobavljač HR d.o.o.', country: 'HR', isSupplier: true, oib: '12345678903' } });
  return { companyId: c.id, actor, model, wh, supplier };
}
type S = Awaited<ReturnType<typeof setup>>;

async function orderOf(s: S, qty: number, unitCost = 100) {
  const o = await transaction((tx) => saveOrder(tx, s.actor, null, { supplierId: s.supplier.id, date: '2026-05-01', lines: [{ modelId: s.model.id, qty, unitCost }] }));
  await transaction((tx) => setOrderStatus(tx, s.actor, o.id, 'ORDERED'));
  const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { orderId: o.id } });
  return { id: o.id, lineId: line.id };
}

const receive = (s: S, o: { id: string; lineId: string } | null, serials: string[], opts: { bookExpense?: boolean } = {}) =>
  transaction((tx) =>
    receiveGoods(tx, s.actor, {
      orderId: o?.id ?? null,
      supplierId: o ? null : s.supplier.id,
      warehouseId: s.wh.id,
      date: '2026-05-10',
      bookExpense: opts.bookExpense,
      lines: [{ modelId: s.model.id, unitCost: 100, serials, orderLineId: o?.lineId ?? null }],
    }),
  );

const invoice = (s: S, id: string | null, over: Partial<Parameters<typeof saveSupplierInvoice>[3]> = {}) =>
  transaction((tx) =>
    saveSupplierInvoice(tx, s.actor, id, { supplierId: s.supplier.id, number: `R-${Math.random().toString(36).slice(2, 8)}`, issueDate: '2026-05-12', netAmount: 200, vatAmount: 50, book: true, ...over }),
  );

/** Zbroj knjiženih troškova robe (primke + ulazni računi) za firmu. */
async function goodsExpense(s: S) {
  const a = await db.expense.aggregate({ where: { companyId: s.companyId, source: { in: ['RECEIPT', 'SUPPLIER_INVOICE'] } }, _sum: { netAmount: true }, _count: { _all: true } });
  return { net: Number(a._sum.netAmount ?? 0), count: a._count._all };
}

before(async () => {
  await db.$connect();
});

after(async () => {
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    await db.purchaseOrder.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

test('račun povezan s primkom ne knjiži vlastiti trošak; povezivanje naknadno briše dvostruki trošak', async () => {
  const s = await setup('rc');
  const r = await receive(s, null, ['RC-1', 'RC-2']);
  assert.deepEqual(await goodsExpense(s), { net: 200, count: 1 });

  // izravno povezan s primkom → trošak ostaje samo na primci
  const a = await invoice(s, null, { receiptId: r.id });
  assert.equal(a.mode, 'receipt');
  assert.deepEqual(await goodsExpense(s), { net: 200, count: 1 });

  // drugi račun knjižen samostalno (vlastiti trošak), pa naknadno povezan s primkom → vlastiti trošak se briše
  const r2 = await receive(s, null, ['RC-3']);
  const b = await invoice(s, null, { netAmount: 100, vatAmount: 25 });
  assert.equal(b.mode, 'own');
  assert.deepEqual(await goodsExpense(s), { net: 400, count: 3 }, 'prije povezivanja: dvaput (primka + račun)');
  const nb = await db.supplierInvoice.findUniqueOrThrow({ where: { id: b.id } });
  const linked = await invoice(s, b.id, { number: nb.number, netAmount: 100, vatAmount: 25, receiptId: r2.id });
  assert.equal(linked.mode, 'receipt');
  assert.deepEqual(await goodsExpense(s), { net: 300, count: 2 }, 'nakon povezivanja: jednom');

  // plaćen račun robe → plaćen i trošak primke
  await transaction((tx) => setSupplierInvoicesPaid(tx, s.actor, [a.id], '2026-05-20'));
  const e = await db.expense.findFirstOrThrow({ where: { receiptId: r.id } });
  assert.equal(e.paid, true);
  assert.equal(e.paidDate?.toISOString().slice(0, 10), '2026-05-20');
});

test('narudžbenica: račun dobavljača s narudžbenice postaje povezan ulazni račun bez dvostrukog troška', async () => {
  const s = await setup('po');
  const o = await orderOf(s, 3);
  // podaci računa prije robe — ulazni račun još ne nastaje
  const none = await transaction((tx) =>
    saveOrderInvoice(tx, s.actor, o.id, {
      supplierInvoiceNo: 'DOB-77', supplierInvoiceDate: '2026-05-09', supplierInvoiceDueDate: '2026-06-09', supplierInvoiceCurrency: 'eur',
      supplierInvoiceNet: 300, supplierInvoiceVat: 75, supplierInvoiceTotal: null,
    }),
  );
  assert.equal(none, null);
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(Number(po.supplierInvoiceTotal), 375);
  assert.equal(po.supplierInvoiceCurrency, 'EUR');

  // prva primka (200) → ulazni račun (300) nastaje, povezan s narudžbenicom; primka nosi 200, račun samo razliku 100
  const r = await receive(s, o, ['PO-1', 'PO-2']);
  const si = await db.supplierInvoice.findFirstOrThrow({ where: { companyId: s.companyId, orderId: o.id } });
  assert.equal(si.number, 'DOB-77');
  assert.equal(Number(si.total), 375);
  assert.equal(Number((await db.expense.findFirstOrThrow({ where: { supplierInvoiceId: si.id } })).netAmount), 100);
  assert.deepEqual(await goodsExpense(s), { net: 300, count: 2 }, 'max(primke 200, račun 300)');

  // druga primka ne stvara drugi ulazni račun; primke sada nose svu robu — račun bez vlastitog troška
  await receive(s, o, ['PO-3']);
  assert.equal(await db.supplierInvoice.count({ where: { companyId: s.companyId, orderId: o.id } }), 1);
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: si.id } }), 0);
  assert.deepEqual(await goodsExpense(s), { net: 300, count: 2 });

  // storno primke briše njen trošak; račun sam opet knjiži razliku iznad preostale primke (usklađivanje)
  await transaction((tx) => cancelReceipt(tx, s.actor, r.id));
  assert.deepEqual(await goodsExpense(s), { net: 300, count: 2 }, 'max(primka 100, račun 300)');
  await assert.rejects(transaction((tx) => rebookSupplierInvoice(tx, s.actor, si.id)), /već knjižen/);
});

test('račun knjižen prije robe: primka knjiži robu, račun se usklađuje (ne dvaput); naknadno knjiženje primke', async () => {
  const s = await setup('first');
  const o = await orderOf(s, 2);
  const si = await invoice(s, null, { orderId: o.id, netAmount: 200, vatAmount: 50 });
  assert.equal(si.mode, 'own', 'nema primke — račun knjiži trošak');
  const r = await receive(s, o, ['F-1', 'F-2']);
  assert.equal(r.booked, true, 'primka knjiži nabavnu vrijednost');
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: si.id } }), 0, 'račun za robu više nema vlastiti trošak');
  assert.deepEqual(await goodsExpense(s), { net: 200, count: 1 });
  await assert.rejects(transaction((tx) => bookReceiptExpense(tx, s.actor, r.id)), /već knjižen/);

  // primka bez knjiženja (prekidač) + račun bez veze → „Knjiži trošak" na primci
  const r2 = await receive(s, null, ['F-3'], { bookExpense: false });
  assert.equal(r2.booked, false);
  await transaction((tx) => bookReceiptExpense(tx, s.actor, r2.id));
  assert.equal(await db.expense.count({ where: { receiptId: r2.id } }), 1);
  await assert.rejects(transaction((tx) => bookReceiptExpense(tx, s.actor, r2.id)), /već knjižen/);
});

test('storno primke: račun za robu sam opet knjiži; „Knjiži ponovno" za neknjižen račun', async () => {
  const s = await setup('rebook');
  const r = await receive(s, null, ['K-1']);
  const si = await invoice(s, null, { receiptId: r.id, netAmount: 100, vatAmount: 25 });
  assert.equal(si.mode, 'receipt');
  // storno primke: račun (veza ostaje) sam opet knjiži vlastiti trošak — usklađivanje
  await transaction((tx) => cancelReceipt(tx, s.actor, r.id));
  assert.deepEqual(await goodsExpense(s), { net: 100, count: 1 });
  await assert.rejects(transaction((tx) => rebookSupplierInvoice(tx, s.actor, si.id)), /već knjižen/);
  // „Knjiži ponovno" je za račun spremljen bez knjiženja
  const off = await invoice(s, null, { netAmount: 40, vatAmount: 10, book: false });
  assert.equal(off.mode, 'none');
  assert.equal(await transaction((tx) => rebookSupplierInvoice(tx, s.actor, off.id)), 'own');
  assert.deepEqual(await goodsExpense(s), { net: 140, count: 2 });
});

test('slobodni unos dobavljača: postojeći po OIB-u, novi partner se otvara, neispravan OIB se odbija', async () => {
  const s = await setup('free');
  // isti OIB → postojeći partner, bez novog
  const a = await invoice(s, null, { supplierId: null, supplierName: 'Nešto drugo', supplierOib: 'HR12345678903', book: false });
  const sa = await db.supplierInvoice.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(sa.supplierId, s.supplier.id);
  assert.equal(a.supplierCreated, false);
  assert.equal(sa.supplierName, 'Nešto drugo', 'naziv kako je upisan ostaje uz račun');

  // novi dobavljač → partner označen kao dobavljač
  const before1 = await db.partner.count({ where: { companyId: s.companyId } });
  const b = await invoice(s, null, { supplierId: null, supplierName: '  Novi   Dobavljač d.o.o. ', supplierOib: '69435151530', book: true });
  assert.equal(b.supplierCreated, true);
  const p = await db.partner.findFirstOrThrow({ where: { companyId: s.companyId, oib: '69435151530' } });
  assert.equal(p.name, 'Novi Dobavljač d.o.o.');
  assert.equal(p.isSupplier, true);
  assert.equal(await db.partner.count({ where: { companyId: s.companyId } }), before1 + 1);
  const e = await db.expense.findFirstOrThrow({ where: { supplierInvoiceId: b.id } });
  assert.equal(e.partnerId, p.id);

  // isti naziv bez OIB-a → isti partner
  const c = await invoice(s, null, { supplierId: null, supplierName: 'novi dobavljač d.o.o.', supplierOib: null, book: false });
  assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: c.id } })).supplierId, p.id);

  await assert.rejects(invoice(s, null, { supplierId: null, supplierName: 'X', supplierOib: '12345678900' }), /nije ispravan/);
  await assert.rejects(invoice(s, null, { supplierId: null, supplierName: null, supplierOib: null }), /naziv i OIB/);

  // veza s narudžbenicom drugog dobavljača se odbija
  const o = await orderOf(s, 1);
  await assert.rejects(invoice(s, null, { supplierId: p.id, orderId: o.id }), /drugog dobavljača/);

  // skupno brisanje: sve ili ništa
  const n = await transaction((tx) => deleteSupplierInvoices(tx, s.actor, [a.id, b.id]));
  assert.equal(n, 2);
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: b.id } }), 0);
});
