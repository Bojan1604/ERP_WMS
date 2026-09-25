/**
 * Skeniranje i inventura bez prava `costs`: odgovor akcije (lookupScanAction,
 * refreshScanAction, scanStocktakeAction) ne smije nositi nabavnu cijenu uređaja.
 * Akcije grade odgovor kroz `lookupScanItems` / `scanItemView` / `stocktakeScanView`.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { createStocktake, scanStocktake } from '../../src/server/services/stocktake';
import { lookupScanItems, scanItemView, scanItemsByIds, stocktakeScanView } from '../../src/server/queries/stocktake';
import { fromISO } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
after(async () => {
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.$disconnect();
});

test('skeniranje i inventura bez prava costs: nema ključa cost u odgovoru', async () => {
  const c = await db.company.create({ data: { name: `B-scan ${Date.now()}-${Math.random()}` } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `bs${Date.now()}${Math.random()}@t.hr`, name: 'Skladištar', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Zebra', name: 'TC21' } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const mk = (serial: string, dupNote: string | null = null) =>
    db.item.create({ data: { companyId: c.id, serial, dupNote, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 777.77, importDate: fromISO('2026-01-01') } });
  const a = await mk('BSC-1');
  await mk('BSC-D', 'prvi');
  await mk('BSC-D', 'drugi');

  const hidden = await lookupScanItems(db, c.id, 'BSC-1', false);
  assert.equal(hidden.items.length, 1);
  assert.ok(!('cost' in hidden.items[0]), 'bez costs nema ključa cost');
  assert.doesNotMatch(JSON.stringify(hidden), /777/);
  const shown = await lookupScanItems(db, c.id, 'BSC-1', true);
  assert.equal(shown.items[0].cost, 777.77, 'uz costs nabavna ostaje');

  const refreshed = (await scanItemsByIds(c.id, [a.id])).map((i) => scanItemView(i, false));
  assert.doesNotMatch(JSON.stringify(refreshed), /777/);

  const st = await transaction((tx) => createStocktake(tx, actor, { warehouseId: wh.id, note: null }));
  const one = await transaction((tx) => scanStocktake(tx, actor, { stocktakeId: st.id, code: 'BSC-1' }));
  assert.doesNotMatch(JSON.stringify(stocktakeScanView(one, false)), /777/, 'uređaj skena inventure bez nabavne');
  const choose = await transaction((tx) => scanStocktake(tx, actor, { stocktakeId: st.id, code: 'BSC-D' }));
  assert.equal(choose.result, 'choose');
  const view = stocktakeScanView(choose, false);
  assert.equal(view.variants.length, 2);
  assert.ok(view.variants.every((v) => !('cost' in v)), 'ponuđeni duplikati bez nabavne');
  assert.match(JSON.stringify(stocktakeScanView(choose, true)), /777\.77/);
});
