/**
 * Nabava i skladište nad testnom bazom: PDV troška primke po zemlji dobavljača
 * narudžbenice, istovremeno zaprimanje iste stavke, storno primke s premještenim
 * uređajima i prilozima, plaćenost troška primke, premještaj kroz međuskladišnicu.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { Actor } from '../../src/server/services/items';
import { cancelReceipt, receiveGoods, saveOrder, setOrderStatus } from '../../src/server/services/purchasing';
import { setExpensesPaid } from '../../src/server/services/expenses';
import { bulkEdit, transferItems, updateItem } from '../../src/server/services/warehouse';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup() {
  const c = await db.company.create({ data: { name: `Nabava ${Date.now()}-${Math.random()}` } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `u${Date.now()}${Math.random()}@t.hr`, name: 'Nabava', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'V2' } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const wh2 = await db.warehouse.create({ data: { companyId: c.id, name: 'Drugo skladište' } });
  const foreign = await db.partner.create({ data: { companyId: c.id, name: 'Sunmi GmbH', country: 'DE', isSupplier: true } });
  return { companyId: c.id, actor, model, wh, wh2, foreign };
}

type S = Awaited<ReturnType<typeof setup>>;

async function order(s: S, qty: number) {
  const o = await transaction((tx) => saveOrder(tx, s.actor, null, { supplierId: s.foreign.id, date: '2026-05-01', lines: [{ modelId: s.model.id, qty, unitCost: 100 }] }));
  await transaction((tx) => setOrderStatus(tx, s.actor, o.id, 'ORDERED'));
  const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { orderId: o.id } });
  return { id: o.id, lineId: line.id };
}

const receiveLine = (s: S, o: { id: string; lineId: string }, serials: string[], unitCost = 100) =>
  transaction((tx) =>
    receiveGoods(tx, s.actor, { orderId: o.id, warehouseId: s.wh.id, date: '2026-05-10', lines: [{ modelId: s.model.id, unitCost, serials, orderLineId: o.lineId }] }),
  );

before(async () => {
  await db.$connect();
});

after(async () => {
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    // stavke narudžbenice drže model — narudžbenice prije firme
    await db.purchaseOrder.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

test('primka po narudžbenici: dobavljač i PDV po zemlji dobavljača narudžbenice', async () => {
  const s = await setup();
  const o = await order(s, 3);
  const r = await receiveLine(s, o, ['DE-1', 'DE-2']);
  const receipt = await db.goodsReceipt.findUniqueOrThrow({ where: { id: r.id } });
  assert.equal(receipt.supplierId, s.foreign.id);
  const e = await db.expense.findFirstOrThrow({ where: { receiptId: r.id } });
  assert.equal(Number(e.netAmount), 200);
  assert.equal(Number(e.vatAmount), 0, 'dobavljač iz EU — bez domaćeg PDV-a');
  assert.equal(e.partnerId, s.foreign.id);
  const item = await db.item.findFirstOrThrow({ where: { companyId: s.companyId, serial: 'DE-1' } });
  assert.equal(item.supplierId, s.foreign.id);

  // primka bez vrijednosti ne knjiži trošak od 0 €
  const zero = await receiveLine(s, o, ['DE-3'], 0);
  assert.equal(await db.expense.count({ where: { receiptId: zero.id } }), 0);
  assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: o.id } })).status, 'RECEIVED');
});

test('istovremeno zaprimanje iste stavke ne prelazi naručenu količinu', async () => {
  const s = await setup();
  const o = await order(s, 2);
  const results = await Promise.allSettled([receiveLine(s, o, ['A-1', 'A-2']), receiveLine(s, o, ['B-1', 'B-2'])]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.equal(ok.length, 1, 'samo jedna primka smije proći');
  const line = await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: o.lineId } });
  assert.equal(line.received, 2);
  assert.equal(await db.item.count({ where: { companyId: s.companyId } }), 2);
  assert.equal(await db.goodsReceipt.count({ where: { companyId: s.companyId } }), 1);
  // i u jednom zahtjevu: dva retka iste stavke zbrajaju se
  const o2 = await order(s, 2);
  await assert.rejects(
    transaction((tx) =>
      receiveGoods(tx, s.actor, {
        orderId: o2.id,
        warehouseId: s.wh.id,
        date: '2026-05-10',
        lines: [
          { modelId: s.model.id, unitCost: 1, serials: ['C-1', 'C-2'], orderLineId: o2.lineId },
          { modelId: s.model.id, unitCost: 1, serials: ['C-3'], orderLineId: o2.lineId },
        ],
      }),
    ),
    /preostalo 2 kom/,
  );
});

test('storno primke: odbija premještene uređaje, briše priloge obrisanih uređaja', async () => {
  const s = await setup();
  const o = await order(s, 4);
  const r1 = await receiveLine(s, o, ['M-1', 'M-2']);
  const moved = await db.item.findFirstOrThrow({ where: { companyId: s.companyId, serial: 'M-1' } });
  await transaction((tx) => transferItems(tx, s.actor, { itemIds: [moved.id], toWarehouseId: s.wh2.id }));
  await assert.rejects(transaction((tx) => cancelReceipt(tx, s.actor, r1.id)), /premješteni.*M-1/);
  // vraćen u izvorno skladište — međuskladišnica i dalje postoji, storno se i dalje odbija
  await transaction((tx) => transferItems(tx, s.actor, { itemIds: [moved.id], toWarehouseId: s.wh.id }));
  await assert.rejects(transaction((tx) => cancelReceipt(tx, s.actor, r1.id)), /premješteni/);
  assert.equal(await db.item.count({ where: { receiptId: r1.id } }), 2);

  const r2 = await receiveLine(s, o, ['P-1']);
  const item = await db.item.findFirstOrThrow({ where: { companyId: s.companyId, serial: 'P-1' } });
  await db.attachment.create({ data: { companyId: s.companyId, entity: 'item', entityId: item.id, fileName: 'a.png', mime: 'image/png', size: 1, data: Buffer.from([1]) } });
  const res = await transaction((tx) => cancelReceipt(tx, s.actor, r2.id));
  assert.equal(res.count, 1);
  assert.equal(await db.item.count({ where: { id: item.id } }), 0);
  assert.equal(await db.attachment.count({ where: { companyId: s.companyId, entity: 'item', entityId: item.id } }), 0);
  assert.equal(await db.expense.count({ where: { receiptId: r2.id } }), 0);
  assert.equal((await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: o.lineId } })).received, 2);
});

test('trošak primke se može označiti plaćenim; ulazni račun ne', async () => {
  const s = await setup();
  const o = await order(s, 1);
  const r = await receiveLine(s, o, ['X-1']);
  const e = await db.expense.findFirstOrThrow({ where: { receiptId: r.id } });
  await transaction((tx) => setExpensesPaid(tx, s.actor, [e.id], true));
  let x = await db.expense.findUniqueOrThrow({ where: { id: e.id } });
  assert.equal(x.paid, true);
  assert.ok(x.paidDate);
  await transaction((tx) => setExpensesPaid(tx, s.actor, [e.id], false));
  x = await db.expense.findUniqueOrThrow({ where: { id: e.id } });
  assert.equal(x.paid, false);
  assert.equal(x.paidDate, null);

  const si = await db.supplierInvoice.create({ data: { companyId: s.companyId, internalNo: 'URA-T-1', supplierId: s.foreign.id, number: 'R1', issueDate: new Date('2026-05-01') } });
  const se = await db.expense.create({ data: { companyId: s.companyId, date: new Date('2026-05-01'), description: 'URA', source: 'SUPPLIER_INVOICE', supplierInvoiceId: si.id } });
  await assert.rejects(transaction((tx) => setExpensesPaid(tx, s.actor, [se.id], true)), /ulaznom računu/);
});

test('promjena skladišta u izmjeni ide kroz međuskladišnicu; uređaj na stanju ne ostaje bez skladišta', async () => {
  const s = await setup();
  const o = await order(s, 3);
  await receiveLine(s, o, ['W-1', 'W-2', 'W-3']);
  const items = await db.item.findMany({ where: { companyId: s.companyId }, orderBy: { serial: 'asc' } });

  const r = await transaction((tx) => bulkEdit(tx, s.actor, { itemIds: [items[0].id, items[1].id], warehouseId: s.wh2.id, note: 'x' }));
  assert.equal(r.transferIds.length, 1);
  assert.equal(await db.transferItem.count({ where: { transferId: r.transferIds[0] } }), 2);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: items[0].id } })).warehouseId, s.wh2.id);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: items[0].id } })).note, 'x');

  const base = (i: (typeof items)[number]) => ({
    serial: i.serial, dupNote: null, modelId: i.modelId, warehouseId: i.warehouseId, supplierId: i.supplierId, cost: 100,
    rentPrice: null, marginPct: null, warrantyMonths: null, importDate: null, note: null,
  });
  await assert.rejects(transaction((tx) => updateItem(tx, s.actor, items[2].id, { ...base(items[2]), warehouseId: null })), /mora biti u nekom skladištu/);
  const u = await transaction((tx) => updateItem(tx, s.actor, items[2].id, { ...base(items[2]), warehouseId: s.wh2.id }));
  assert.ok(u.transfer);
  assert.equal(await db.transferItem.count({ where: { itemId: items[2].id } }), 1);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: items[2].id } })).warehouseId, s.wh2.id);

  // prazna nabavna cijena u grupnoj izmjeni ne postaje 0
  await assert.rejects(transaction((tx) => bulkEdit(tx, s.actor, { itemIds: [items[0].id], cost: null })), /nabavnu cijenu/);
});
