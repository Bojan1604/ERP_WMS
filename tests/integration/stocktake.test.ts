/**
 * Inventura i skeniranje nad pravom bazom (wms_test).  npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { closeStocktake, createStocktake, deleteStocktake, removeScan, scanStocktake } from '../../src/server/services/stocktake';
import { findItemsByCode, stocktakeLiveCounts, stocktakeRows } from '../../src/server/queries/stocktake';
import { fromISO } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup() {
  const c = await db.company.create({ data: { name: `Inv ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `inv${Date.now()}${Math.random()}@t.hr`, name: 'Skladištar', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Zebra', name: 'TC21' } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const wh2 = await db.warehouse.create({ data: { companyId: c.id, name: 'Drugo skladište' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const sold = await transaction((tx) => statusFor(tx, c.id, 'SOLD'));
  const mk = (serial: string, over: Record<string, unknown> = {}) =>
    db.item.create({
      data: { companyId: c.id, serial, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 50, importDate: fromISO('2026-01-01'), ...over },
    });
  const items = {
    a: await mk('INV-A'),
    b: await mk('INV-B'),
    c: await mk('INV-C'),
    other: await mk('INV-X', { warehouseId: wh2.id }),
    sold: await mk('INV-S', { statusId: sold.id, state: 'SOLD', warehouseId: null }),
    dup1: await mk('INV-D', { dupNote: 'prvi' }),
    dup2: await mk('INV-D', { dupNote: 'drugi', warehouseId: wh2.id }),
  };
  return { companyId: c.id, actor, wh, wh2, items };
}

before(async () => {
  await db.$connect();
});

after(async () => {
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

test('kod → uređaj: točno, prefiks, GS1, poveznica, dio broja, duplikati', async () => {
  const s = await setup();
  const find = (code: string) => findItemsByCode(db, s.companyId, code);
  assert.equal((await find('INV-A')).via, 'exact');
  const pref = await find('S/N: INV-B');
  assert.equal(pref.via, 'variant');
  assert.equal(pref.items[0].id, s.items.b.id);
  assert.equal((await find('inv-c')).items[0].id, s.items.c.id);
  assert.equal((await find('(01)04012345678901(21)INV-C')).items[0].id, s.items.c.id);
  const link = await find(`https://erp.example.hr/skladiste/${s.items.a.id}`);
  assert.equal(link.via, 'link');
  assert.equal(link.items[0].id, s.items.a.id);
  // „INV-" je dio više brojeva — nije jednoznačno
  assert.equal((await find('INV-')).items.length, 0);
  assert.equal((await find('NEPOSTOJI-123')).items.length, 0);
  assert.equal((await find('INV-D')).items.length, 2);
});

test('inventura: brojači, duplikat, višak, poništenje, istovremeni sken', async () => {
  const s = await setup();
  const st = await transaction((tx) => createStocktake(tx, s.actor, { warehouseId: s.wh.id, note: null }));
  assert.match(st.number, /^INV-\d{4}-\d+/);
  const scan = (code: string, itemId?: string) => transaction((tx) => scanStocktake(tx, s.actor, { stocktakeId: st.id, code, itemId }));

  // očekivano: A, B, C i D(prvi) na stanju u glavnom skladištu
  let r = await scan('INV-A');
  assert.equal(r.result, 'added');
  assert.equal(r.kind, 'found');
  assert.deepEqual([r.counts.expected, r.counts.found, r.counts.missing, r.counts.extra], [4, 1, 3, 0]);

  assert.equal((await scan('INV-A')).result, 'duplicate');
  // isti broj istovremeno iz dva mobitela: jedan dodaje, drugi je duplikat, nijedan ne pada
  const both = await Promise.all([scan('INV-B'), scan('INV-B')]);
  assert.deepEqual(both.map((x) => x.result).sort(), ['added', 'duplicate']);

  assert.equal((await scan('INV-X')).kind, 'wrongWarehouse');
  assert.equal((await scan('INV-S')).kind, 'notInStock');
  const unk = await scan('NEPOZNAT-1');
  assert.equal(unk.kind, 'unknown');
  // duplikat serijskog: očekivan je samo „prvi" (drugi je u drugom skladištu)
  const d = await scan('INV-D');
  assert.equal(d.item?.id, s.items.dup1.id);
  assert.equal(d.serial, 'INV-D (prvi)');
  // drugi sken istog broja: preostaje samo „drugi"
  const d2 = await scan('INV-D');
  assert.equal(d2.item?.id, s.items.dup2.id);

  let counts = await stocktakeLiveCounts(db, s.companyId, { id: st.id, warehouseId: s.wh.id });
  assert.deepEqual([counts.expected, counts.found, counts.missing, counts.extra], [4, 3, 1, 4]);

  // poništenje skena
  const rm = await transaction((tx) => removeScan(tx, s.actor, { stocktakeId: st.id, scanId: unk.scanId! }));
  assert.equal(rm.removed, 1);
  assert.equal(rm.counts.extra, 3);

  const missing = await stocktakeRows(s.companyId, { id: st.id, warehouseId: s.wh.id }, 'missing', { skip: 0, take: 50 });
  assert.deepEqual(missing.map((m) => m.itemSerial), ['INV-C']);
  const extra = await stocktakeRows(s.companyId, { id: st.id, warehouseId: s.wh.id }, 'extra', { skip: 0, take: 50 });
  assert.deepEqual(extra.map((m) => m.serial).sort(), ['INV-D (drugi)', 'INV-S', 'INV-X']);

  // zatvaranje: premještaj zalutalih, nedostajući dobivaju status
  const other = await db.itemStatus.create({ data: { companyId: s.companyId, name: 'Nedostaje', kind: 'OTHER' } });
  const closed = await transaction((tx) =>
    closeStocktake(tx, s.actor, { id: st.id, moveWrongWarehouse: true, missing: { kind: 'status', statusId: other.id } }),
  );
  assert.equal(closed.summary.actions.moved, 2); // INV-X i INV-D (drugi)
  assert.equal(closed.summary.actions.transfers.length, 1);
  assert.equal(closed.summary.actions.missingChanged, 1);
  assert.equal(closed.summary.missing, 1);
  assert.equal(closed.summary.wrongWarehouse, 2);
  assert.equal(closed.summary.rows.missing[0].serial, 'INV-C');
  const c = await db.item.findUniqueOrThrow({ where: { id: s.items.c.id } });
  assert.equal(c.statusId, other.id);
  assert.equal(c.state, 'OTHER');
  const x = await db.item.findUniqueOrThrow({ where: { id: s.items.other.id } });
  assert.equal(x.warehouseId, s.wh.id);
  assert.ok(await db.itemEvent.findFirst({ where: { itemId: s.items.c.id, type: 'STATUS', message: { contains: 'inventura' } } }));

  await assert.rejects(scan('INV-C'), /zatvorena/);
  await assert.rejects(transaction((tx) => deleteStocktake(tx, s.actor, st.id)), /zatvorena/);
});

test('inventura svih skladišta i otpis nedostajućih', async () => {
  const s = await setup();
  const st = await transaction((tx) => createStocktake(tx, s.actor, { warehouseId: null, note: 'Godišnja' }));
  const scan = (code: string) => transaction((tx) => scanStocktake(tx, s.actor, { stocktakeId: st.id, code }));
  assert.equal((await scan('INV-X')).kind, 'found'); // bilo koje skladište
  const counts = await stocktakeLiveCounts(db, s.companyId, { id: st.id, warehouseId: null });
  assert.equal(counts.expected, 6);
  const closed = await transaction((tx) => closeStocktake(tx, s.actor, { id: st.id, moveWrongWarehouse: false, missing: { kind: 'writeOff', bookExpense: true } }));
  assert.equal(closed.summary.actions.missingChanged, 5);
  assert.equal(await db.item.count({ where: { companyId: s.companyId, state: 'WRITTEN_OFF' } }), 5);
  const exp = await db.expense.findFirst({ where: { companyId: s.companyId, source: 'WRITE_OFF' } });
  assert.equal(Number(exp?.netAmount), 250);
});

test('brojevi inventura rastu po godini, druga firma ne vidi tuđu inventuru', async () => {
  const s = await setup();
  const t = await setup();
  const a = await transaction((tx) => createStocktake(tx, s.actor, { warehouseId: null, note: null }));
  const b = await transaction((tx) => createStocktake(tx, s.actor, { warehouseId: s.wh.id, note: null }));
  assert.notEqual(a.number, b.number);
  await assert.rejects(transaction((tx) => scanStocktake(tx, t.actor, { stocktakeId: a.id, code: 'INV-A' })), /ne postoji/);
  await assert.rejects(transaction((tx) => createStocktake(tx, t.actor, { warehouseId: s.wh.id, note: null })), /ne postoji/);
  await transaction((tx) => deleteStocktake(tx, s.actor, a.id));
  assert.equal(await db.stocktake.count({ where: { id: a.id } }), 0);
});
