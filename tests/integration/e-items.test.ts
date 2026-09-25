/**
 * Područje E — skladište nad testnom bazom: pravila brisanja uređaja, skupna
 * izmjena klijenta i marže, ručni ispravci na kartici, izlaz na postojeći ugovor,
 * specifikacije s modela i prekidač knjiženja nabave pri zaprimanju.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { addOutToContract, bulkEdit, deleteItems, markOut, receiveItems, transferItems, updateItem } from '../../src/server/services/warehouse';
import { addDevices, createContract } from '../../src/server/services/rentals';
import { createDraft } from '../../src/server/services/invoices';
import { itemFacets, listItems, parseItemFilters } from '../../src/server/queries/warehouse';
import { fromISO } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup(tag: string) {
  const c = await db.company.create({ data: { name: `E ${tag} ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `e${tag}${Date.now()}${Math.random()}@t.hr`, name: 'Skladište E', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Zebra', name: `TC-${tag}`, cpu: 'Snapdragon 660', screen: '5"', os: 'Android 11' } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const wh2 = await db.warehouse.create({ data: { companyId: c.id, name: 'Drugo' } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const sold = await transaction((tx) => statusFor(tx, c.id, 'SOLD'));
  const mk = (serial: string, over: Record<string, unknown> = {}) =>
    db.item.create({ data: { companyId: c.id, serial, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2026-01-10'), ...over } });
  return { companyId: c.id, actor, model, wh, wh2, partner, stock, sold, mk };
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

test('brisanje: slobodan uređaj se briše s prilozima; račun, ugovor i međuskladišnica blokiraju', async () => {
  const s = await setup('del');
  const free = await s.mk('DEL-FREE');
  await db.attachment.create({ data: { companyId: s.companyId, entity: 'item', entityId: free.id, fileName: 'a.jpg', mime: 'image/jpeg', size: 1, data: Buffer.from([1]) } });
  const r = await transaction((tx) => deleteItems(tx, s.actor, [free.id]));
  assert.equal(r.count, 1);
  assert.equal(await db.item.count({ where: { id: free.id } }), 0);
  assert.equal(await db.attachment.count({ where: { companyId: s.companyId, entity: 'item', entityId: free.id } }), 0, 'prilozi uređaja se brišu s njim');

  // na računu (zadnji račun uređaja)
  const onInvoice = await s.mk('DEL-INV');
  const inv = await transaction((tx) =>
    createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: '2026-03-01', vatRate: 25, lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 10 }] }),
  );
  await db.item.update({ where: { id: onInvoice.id }, data: { invoiceId: inv.id } });
  // međuskladišnica
  const moved = await s.mk('DEL-MOVED');
  await transaction((tx) => transferItems(tx, s.actor, { itemIds: [moved.id], toWarehouseId: s.wh2.id }));
  // ugovor
  const rented = await s.mk('DEL-RENT');
  const c = await transaction((tx) =>
    createContract(tx, s.actor, { partnerId: s.partner.id, startDate: '2026-01-01', endDate: null, firstBillingDate: null, billingDay: null, billing: 'MONTHLY', billingMode: 'IN_ADVANCE', seasonFrom: null, seasonTo: null, note: null }),
  );
  await transaction((tx) => addDevices(tx, s.actor, c.id, [{ itemId: rented.id, monthly: 20, plan: [] }], { skipPast: false }));

  const plain = await s.mk('DEL-OK');
  await assert.rejects(
    transaction((tx) => deleteItems(tx, s.actor, [plain.id, onInvoice.id, moved.id, rented.id])),
    (e: Error) => /na računu: DEL-INV/.test(e.message) && /međuskladišnici: DEL-MOVED/.test(e.message) && /ugovoru o najmu: DEL-RENT/.test(e.message),
  );
  // sve ili ništa — ni slobodan uređaj iz istog odabira nije obrisan
  assert.equal(await db.item.count({ where: { id: plain.id } }), 1);
});

test('skupna izmjena: klijent (postavi/ukloni) samo izvan skladišta, bruto marža i vraćanje na model', async () => {
  const s = await setup('bulk');
  const out1 = await s.mk('B-1', { statusId: s.sold.id, state: 'SOLD', warehouseId: null });
  const out2 = await s.mk('B-2', { statusId: s.sold.id, state: 'SOLD', warehouseId: null });
  const inStock = await s.mk('B-3');

  await transaction((tx) => bulkEdit(tx, s.actor, { itemIds: [out1.id, out2.id], partnerId: s.partner.id, marginPct: 22.5 }));
  let rows = await db.item.findMany({ where: { id: { in: [out1.id, out2.id] } } });
  assert.ok(rows.every((r) => r.partnerId === s.partner.id && Number(r.marginPct) === 22.5));
  assert.equal(await db.itemEvent.count({ where: { itemId: out1.id, type: 'EDIT' } }), 1);

  await assert.rejects(transaction((tx) => bulkEdit(tx, s.actor, { itemIds: [inStock.id], partnerId: s.partner.id })), /na skladištu ne mogu imati klijenta/);
  await assert.rejects(transaction((tx) => bulkEdit(tx, s.actor, { itemIds: [out1.id], marginPct: 120 })), /između 0 i 100/);

  // ukloni klijenta i vrati maržu na model/firmu
  await transaction((tx) => bulkEdit(tx, s.actor, { itemIds: [out1.id, out2.id], partnerId: null, marginPct: null }));
  rows = await db.item.findMany({ where: { id: { in: [out1.id, out2.id] } } });
  assert.ok(rows.every((r) => r.partnerId === null && r.marginPct === null));
});

test('kartica: ručni ispravci (prodajna, datum izlaza, račun, klijent, kategorija, specifikacije); bez nabavne se nabavna ne mijenja', async () => {
  const s = await setup('card');
  const it = await s.mk('C-1', { statusId: s.sold.id, state: 'SOLD', warehouseId: null });
  const cat = await db.category.create({ data: { companyId: s.companyId, name: 'Skeneri E' } });
  const inv = await transaction((tx) =>
    createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: '2026-03-01', vatRate: 25, lines: [{ kind: 'MANUAL', description: 'X', qty: 1, unitPrice: 1 }] }),
  );
  // račun se veže samo uz prodan uređaj koji je stavka izdanog računa
  await db.invoiceLine.create({ data: { invoiceId: inv.id, kind: 'DEVICE', itemId: it.id, description: 'C-1' } });
  await db.invoice.update({ where: { id: inv.id }, data: { status: 'ISSUED', number: `E-${Date.now()}` } });
  const base = { serial: 'C-1', dupNote: null, modelId: s.model.id, warehouseId: null, supplierId: null, rentPrice: null, warrantyMonths: null, importDate: '2026-01-10', note: null };
  const r = await transaction((tx) =>
    updateItem(tx, s.actor, it.id, { ...base, salePrice: 199.9, issueDate: '2026-02-02', invoiceId: inv.id, partnerId: s.partner.id, categoryId: cat.id, cpu: ' i5 ', screen: '', os: 'Win 11' }),
  );
  assert.ok(r.changed.includes('salePrice') && r.changed.includes('invoiceId') && r.changed.includes('partnerId'));
  const after1 = await db.item.findUniqueOrThrow({ where: { id: it.id } });
  assert.equal(Number(after1.salePrice), 199.9);
  assert.equal(after1.issueDate?.toISOString().slice(0, 10), '2026-02-02');
  assert.equal(after1.invoiceId, inv.id);
  assert.equal(after1.partnerId, s.partner.id);
  assert.equal(after1.categoryId, cat.id);
  assert.equal(after1.cpu, 'i5');
  assert.equal(after1.screen, null);
  assert.equal(Number(after1.cost), 100, 'nabavna ostaje kad se ne šalje (korisnik bez prava na nabavne cijene)');

  // klijent se ne upisuje uređaju na skladištu
  const stockItem = await s.mk('C-2');
  await assert.rejects(transaction((tx) => updateItem(tx, s.actor, stockItem.id, { ...base, serial: 'C-2', warehouseId: s.wh.id, partnerId: s.partner.id })), /na skladištu/);
  // tuđi račun ne prolazi
  const sold2 = await s.mk('C-3', { statusId: s.sold.id, state: 'SOLD', warehouseId: null, issueDate: fromISO('2026-02-01') });
  await assert.rejects(transaction((tx) => updateItem(tx, s.actor, sold2.id, { ...base, serial: 'C-3', invoiceId: 'nepostojeci' })), /Račun ne postoji/);

  // kategorija po komadu u filtru popisa (kategorija uređaja ima prednost pred modelovom)
  const list = await listItems(s.companyId, parseItemFilters({ category: cat.id }, { canSeeCost: true }), { skip: 0, take: 50 });
  assert.deepEqual(list.rows.map((x) => x.serial), ['C-1']);
});

test('zaprimanje: specifikacije s modela, prekidač knjiženja troška; popis filtrira i sortira po stupcima uređaja', async () => {
  const s = await setup('recv');
  const common = { modelId: s.model.id, warehouseId: s.wh.id, supplierId: null, cost: 50, importDate: '2026-04-01', supplierDocNumber: null, note: null, skipExisting: false, dupNote: null };
  const a = await transaction((tx) => receiveItems(tx, s.actor, { ...common, serials: ['R-1', 'R-2'] }));
  assert.equal(await db.expense.count({ where: { receiptId: a.receiptId } }), 1);
  const b = await transaction((tx) => receiveItems(tx, s.actor, { ...common, cost: 70, serials: ['R-3'], os: 'Android 13', bookExpense: false }));
  assert.equal(await db.expense.count({ where: { receiptId: b.receiptId } }), 0, 'bez knjiženja nabave nema troška');
  const r1 = await db.item.findFirstOrThrow({ where: { companyId: s.companyId, serial: 'R-1' } });
  assert.equal(r1.cpu, 'Snapdragon 660');
  assert.equal(r1.os, 'Android 11');
  const r3 = await db.item.findFirstOrThrow({ where: { companyId: s.companyId, serial: 'R-3' } });
  assert.equal(r3.os, 'Android 13', 'upisana vrijednost ima prednost pred modelom');

  const byOs = await listItems(s.companyId, parseItemFilters({ os: 'Android 13' }, { canSeeCost: true }), { skip: 0, take: 50 });
  assert.deepEqual(byOs.rows.map((x) => x.serial), ['R-3']);
  const sorted = await listItems(s.companyId, parseItemFilters({ sort: 'nabavna', dir: 'desc' }, { canSeeCost: true }), { skip: 0, take: 50 });
  assert.equal(sorted.rows[0].serial, 'R-3');
  const bySerial = await listItems(s.companyId, parseItemFilters({ sort: 'serijski', dir: 'asc', year: '2026,2020' }, { canSeeCost: true }), { skip: 0, take: 50 });
  assert.deepEqual(bySerial.rows.map((x) => x.serial), ['R-1', 'R-2', 'R-3']);
  const facets = await itemFacets(s.companyId);
  assert.deepEqual(facets.years, [2026]);
  assert.deepEqual(facets.os, ['Android 11', 'Android 13']);
});

test('izlaz na postojeći ugovor: izašli uređaj ulazi na aktivni ugovor s cijenom i klijentom ugovora', async () => {
  const s = await setup('out');
  const it = await s.mk('O-1', { rentPrice: 15 });
  const it2 = await s.mk('O-2');
  const stay = await s.mk('O-3');
  await db.priceAgreement.create({ data: { companyId: s.companyId, partnerId: s.partner.id, modelId: s.model.id, rentPrice: 12 } });
  await transaction((tx) => markOut(tx, s.actor, { itemIds: [it.id, it2.id], partnerId: s.partner.id }));
  const c = await transaction((tx) =>
    createContract(tx, s.actor, { partnerId: s.partner.id, startDate: '2026-01-01', endDate: null, firstBillingDate: null, billingDay: null, billing: 'MONTHLY', billingMode: 'IN_ADVANCE', seasonFrom: null, seasonTo: null, note: null }),
  );
  // uređaj na skladištu (nije izašao) ne ide s izlaza na ugovor
  await assert.rejects(transaction((tx) => addOutToContract(tx, s.actor, c.id, [stay.id])), /izašli iz skladišta/);
  const r = await transaction((tx) => addOutToContract(tx, s.actor, c.id, [it.id, it2.id]));
  assert.equal(r.count, 2);
  const after1 = await db.item.findUniqueOrThrow({ where: { id: it.id }, include: { contractItem: true } });
  // dogovorena cijena kupca ima prednost pred cijenom uređaja
  assert.equal(Number(after1.contractItem?.monthly), 12);
  assert.equal(after1.state, 'RENTED');
  assert.equal(after1.partnerId, s.partner.id);
  assert.equal(after1.contractItem?.contractId, c.id);
  assert.equal(after1.outAt, null, 'trag izlaza se briše kad uređaj ode u najam');
});
