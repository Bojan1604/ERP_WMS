/**
 * Jednokratno usklađivanje troška robe (krug 2, stavka 9): stari dvostruko knjiženi trošak
 * (primka + račun za robu) vidi se u provjeri dosljednosti, popravak ga usklađuje po pravilu
 * max(primke, računi za robu) uz zapis u dnevniku po narudžbenici; drugi prolaz ne mijenja ništa.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { Actor } from '../../src/server/services/items';
import { receiveGoods, saveOrder, setOrderStatus } from '../../src/server/services/purchasing';
import { saveSupplierInvoice } from '../../src/server/services/supplier-invoices';
import { goodsExpenseMismatches, reconcileAllGoodsExpenses } from '../../src/server/services/goods-expense';
import { fixIntegrity, integrityCheck } from '../../src/server/services/maintenance';
import { GOODS_RECONCILE_KEY, runGoodsReconcileOnce } from '../../src/server/jobs/goods-reconcile';
import { fromISO } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

let s: { companyId: string; actor: Actor; modelId: string; whId: string; supplierId: string };

before(async () => {
  const c = await db.company.create({ data: { name: `B-reconcile ${Date.now()}-${Math.random()}` } });
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `br${Date.now()}${Math.random()}@t.hr`, name: 'Nabava', passwordHash: 'x', role: 'ADMIN' } });
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

/** Narudžbenica 2 × 100 €, primka (trošak 200 €) i račun za robu 200 € — po pravilu račun nema vlastitog troška. */
async function orderWithInvoice(tag: string) {
  const o = await transaction((tx) => saveOrder(tx, s.actor, null, { supplierId: s.supplierId, date: '2026-05-01', lines: [{ modelId: s.modelId, qty: 2, unitCost: 100 }] }));
  await transaction((tx) => setOrderStatus(tx, s.actor, o.id, 'ORDERED'));
  const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { orderId: o.id } });
  await transaction((tx) =>
    receiveGoods(tx, s.actor, {
      orderId: o.id, warehouseId: s.whId, date: '2026-05-10', bookExpense: true,
      lines: [{ modelId: s.modelId, unitCost: 100, serials: [`${tag}-1`, `${tag}-2`], orderLineId: line.id }],
    }),
  );
  const si = await transaction((tx) =>
    saveSupplierInvoice(tx, s.actor, null, {
      supplierId: s.supplierId, number: `${tag}-R1`, issueDate: '2026-05-12', netAmount: 200, vatAmount: 50, category: 'Nabava robe', orderId: o.id, book: true,
    }),
  );
  return { orderId: o.id, invoiceId: si.id };
}

/** Stanje iz starije verzije: račun za robu uz knjiženu primku ima i vlastiti trošak (dvostruko). */
async function doubleBook(invoiceId: string) {
  await db.expense.create({
    data: { companyId: s.companyId, date: fromISO('2026-05-12'), description: 'Ulazni račun (stara verzija)', netAmount: 200, vatAmount: 50, source: 'SUPPLIER_INVOICE', supplierInvoiceId: invoiceId, paid: true, paidDate: fromISO('2026-05-20') },
  });
}

const ownExpense = (invoiceId: string) => db.expense.findUnique({ where: { supplierInvoiceId: invoiceId }, select: { netAmount: true } });

test('provjera dosljednosti prikazuje dvostruko knjiženi trošak robe, popravak ga usklađuje uz trag', async () => {
  const a = await orderWithInvoice('RC1');
  assert.equal(await ownExpense(a.invoiceId), null, 'po pravilu račun za robu uz primku nema vlastitog troška');
  assert.equal((await goodsExpenseMismatches(db, s.companyId)).length, 0);

  await doubleBook(a.invoiceId);
  const mm = await goodsExpenseMismatches(db, s.companyId);
  assert.equal(mm.length, 1);
  assert.deepEqual(mm[0].group, { orderId: a.orderId });
  assert.equal(mm[0].booked, 200);
  assert.equal(mm[0].expected, 0);
  const finding = (await integrityCheck(s.companyId)).find((f) => f.code === 'goods-expense');
  assert.ok(finding && finding.fixable && finding.count === 1 && finding.samples[0].href === `/nabava/narudzbenice/${a.orderId}`);

  const fixed = await transaction((tx) => fixIntegrity(tx, s.actor));
  assert.equal(fixed['goods-expense'], 1);
  assert.equal(await ownExpense(a.invoiceId), null);
  assert.equal((await goodsExpenseMismatches(db, s.companyId)).length, 0);
  const log = await db.auditLog.findFirst({ where: { companyId: s.companyId, entity: 'purchaseOrder', entityId: a.orderId, action: 'goods-expense-fix' } });
  assert.ok(log, 'zapis u dnevniku po narudžbenici');
  assert.match(log.summary, /200,00|200\.00/);
  assert.deepEqual((log.diff as { invoices: Array<{ net: number; invoicePaid: boolean }> }).invoices.map((i) => i.net), [200]);

  // idempotentno
  assert.equal(await transaction((tx) => reconcileAllGoodsExpenses(tx, s.actor)), 0);
});

test('jednokratni posao pri pokretanju: usklađuje i upisuje oznaku, drugi put ništa', async () => {
  const b = await orderWithInvoice('RC2');
  await doubleBook(b.invoiceId);
  const r = await runGoodsReconcileOnce();
  assert.equal(r.find((x) => x.companyId === s.companyId)?.groups, 1);
  assert.equal(await ownExpense(b.invoiceId), null);
  assert.ok(await db.auditLog.findFirst({ where: { companyId: s.companyId, entity: 'job', entityId: GOODS_RECONCILE_KEY } }));
  // isti proces: više se ne pokreće
  assert.deepEqual(await runGoodsReconcileOnce(), []);
});
