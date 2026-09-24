/**
 * Integracijski testovi servisnih naloga (zamjena, povrat, ponovno otvaranje)
 * i prava nad administratorima. Zasebna testna baza: npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { attachItems, pendingForCompany, issueInstallments, setPausedPeriod, updateContractItems } from '../../src/server/services/rentals';
import { changeServiceStatus, createServiceOrder, replaceDevice, returnDevice } from '../../src/server/services/service';
import { saveUser } from '../../src/server/services/users';
import { fromISO, today, addMonths } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup() {
  const c = await db.company.create({ data: { name: `Test ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `u${Date.now()}${Math.random()}@t.hr`, name: 'Tester', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20 } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const items = [];
  for (let i = 0; i < 4; i++) {
    items.push(
      await db.item.create({
        data: { companyId: c.id, serial: `SN${i}`, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2026-01-01') },
      }),
    );
  }
  return { companyId: c.id, actor, admin: u, wh, partner, items };
}

/** Ugovor od prije tri mjeseca, jedan uređaj, sve dosadašnje rate izdane. */
async function rentedAndBilled(s: Awaited<ReturnType<typeof setup>>) {
  const start = addMonths(today(), -3).slice(0, 7) + '-01';
  const contract = await db.contract.create({
    data: { companyId: s.companyId, number: `UG-S-${Math.random()}`, partnerId: s.partner.id, startDate: fromISO(start), billing: 'MONTHLY' },
  });
  await transaction((tx) => attachItems(tx, s.actor, contract.id, [{ itemId: s.items[0].id, monthly: 20 }], { issueDate: start }));
  const pending = await transaction((tx) => pendingForCompany(tx, s.companyId));
  assert.equal(pending.length, 4);
  await transaction((tx) => issueInstallments(tx, s.actor, pending.map((p) => ({ contractId: p.contractId, period: p.period })), { paid: true }));
  assert.equal((await transaction((tx) => pendingForCompany(tx, s.companyId))).length, 0);
  return contract;
}

const newOrder = (s: Awaited<ReturnType<typeof setup>>, itemId: string, setServiceStatus: boolean) =>
  transaction((tx) => createServiceOrder(tx, s.actor, { itemId, issue: 'Ne pali', reportedAt: today(), status: 'RECEIVED', underWarranty: false, setServiceStatus }));

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

for (const setServiceStatus of [false, true]) {
  test(`zamjena uređaja u najmu ne naplaćuje ponovno već fakturirana razdoblja (uređaj ${setServiceStatus ? 'skinut s ugovora' : 'na ugovoru'})`, async () => {
    const s = await setup();
    const contract = await rentedAndBilled(s);
    const order = await newOrder(s, s.items[0].id, setServiceStatus);
    await transaction((tx) => replaceDevice(tx, s.actor, order.id, { replacementId: s.items[1].id, originalTo: 'IN_STOCK', warehouseId: s.wh.id }));

    const ci = await db.contractItem.findUniqueOrThrow({ where: { itemId: s.items[1].id } });
    assert.equal(ci.contractId, contract.id);
    assert.equal(await db.contractItem.count({ where: { itemId: s.items[0].id } }), 0);
    // ništa ne smije ponovno dospjeti
    assert.equal((await transaction((tx) => pendingForCompany(tx, s.companyId))).length, 0);
    // sljedeće razdoblje naplaćuje se za zamjenski uređaj — nema praznine
    const next = addMonths(today(), 1).slice(0, 7);
    const later = await transaction((tx) => pendingForCompany(tx, s.companyId, { now: `${next}-28` }));
    assert.deepEqual(later.map((p) => p.period), [next]);
    assert.equal(later[0].amount, 20);
    assert.deepEqual(later[0].lines.map((l) => l.itemId), [s.items[1].id]);
  });
}

test('zamjena: ugovor koji više nije aktivan odbija zamjenski uređaj u najmu', async () => {
  const s = await setup();
  const contract = await rentedAndBilled(s);
  const order = await newOrder(s, s.items[0].id, true);
  await db.contract.update({ where: { id: contract.id }, data: { status: 'TERMINATED' } });
  await assert.rejects(
    transaction((tx) => replaceDevice(tx, s.actor, order.id, { replacementId: s.items[1].id, originalTo: 'IN_STOCK', warehouseId: s.wh.id })),
    /nije aktivan/,
  );
  const repl = await db.item.findUniqueOrThrow({ where: { id: s.items[1].id } });
  assert.equal(repl.state, 'IN_STOCK');
});

test('povrat: uređaj iz najma ne može se vratiti kupcu kao prodan', async () => {
  const s = await setup();
  await rentedAndBilled(s);
  const order = await newOrder(s, s.items[0].id, true);
  await transaction((tx) => changeServiceStatus(tx, s.actor, order.id, 'REPAIRED'));
  await assert.rejects(transaction((tx) => returnDevice(tx, s.actor, order.id, 'SOLD')), /nije bio prodan/);
  await transaction((tx) => returnDevice(tx, s.actor, order.id, 'RENTED'));
  const it = await db.item.findUniqueOrThrow({ where: { id: s.items[0].id } });
  assert.equal(it.state, 'RENTED');
});

test('ponovno otvaranje zatvorenog naloga nije moguće ako uređaj ima drugi otvoren nalog', async () => {
  const s = await setup();
  const a = await newOrder(s, s.items[2].id, false);
  await transaction((tx) => changeServiceStatus(tx, s.actor, a.id, 'REPAIRED'));
  const b = await newOrder(s, s.items[2].id, false);
  await assert.rejects(transaction((tx) => changeServiceStatus(tx, s.actor, a.id, 'DIAGNOSIS')), /već ima otvoren servisni nalog/);
  await transaction((tx) => changeServiceStatus(tx, s.actor, b.id, 'REPAIRED'));
  await transaction((tx) => changeServiceStatus(tx, s.actor, a.id, 'DIAGNOSIS'));
});

test('korisnici: samo administrator dodjeljuje ulogu administratora i uređuje administratore', async () => {
  const s = await setup();
  const mgr = await db.user.create({ data: { companyId: s.companyId, email: `m${Date.now()}${Math.random()}@t.hr`, name: 'Voditelj', passwordHash: 'x', role: 'MANAGER' } });
  const manager: Actor = { id: mgr.id, name: mgr.name, companyId: s.companyId };
  const input = (email: string, role: 'ADMIN' | 'SALES', password: string | null = 'lozinka123') => ({ name: 'Novi', email, role, active: true, password, permissions: {} });

  await assert.rejects(transaction((tx) => saveUser(tx, manager, null, input(`a${Math.random()}@t.hr`, 'ADMIN'))), /Samo administrator/);
  const sales = await transaction((tx) => saveUser(tx, manager, null, input(`s${Math.random()}@t.hr`, 'SALES')));
  // promaknuće u administratora
  await assert.rejects(transaction((tx) => saveUser(tx, manager, sales, input(`s2${Math.random()}@t.hr`, 'ADMIN', null))), /Samo administrator/);
  // izmjena lozinke administratora
  await assert.rejects(
    transaction((tx) => saveUser(tx, manager, s.admin.id, { ...input(s.admin.email, 'ADMIN'), name: s.admin.name })),
    /Samo administrator/,
  );
  // administrator smije
  await transaction((tx) => saveUser(tx, s.actor, sales, input(`s3${Math.random()}@t.hr`, 'ADMIN', null)));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: sales } })).role, 'ADMIN');
});

/** Ugovor od prije tri mjeseca, jedan uređaj; izdane sve rate osim najstarije. */
async function rentedOneUnbilled(s: Awaited<ReturnType<typeof setup>>) {
  const start = addMonths(today(), -3).slice(0, 7) + '-01';
  const contract = await db.contract.create({
    data: { companyId: s.companyId, number: `UG-U-${Math.random()}`, partnerId: s.partner.id, startDate: fromISO(start), billing: 'MONTHLY' },
  });
  await transaction((tx) => attachItems(tx, s.actor, contract.id, [{ itemId: s.items[0].id, monthly: 20 }], { issueDate: start }));
  const pending = await transaction((tx) => pendingForCompany(tx, s.companyId));
  await transaction((tx) => issueInstallments(tx, s.actor, pending.slice(1).map((p) => ({ contractId: p.contractId, period: p.period }))));
  return { contract, unbilled: pending[0].period };
}

test('zamjena uređaja skinutog s ugovora: nefakturirana rata traži se jednom (za zamjenski)', async () => {
  const s = await setup();
  const { contract, unbilled } = await rentedOneUnbilled(s);
  const order = await newOrder(s, s.items[0].id, true);
  assert.equal(await db.returnedContractItem.count({ where: { contractId: contract.id } }), 1, 'odlazak u servis čuva zaostalu ratu');
  await transaction((tx) => replaceDevice(tx, s.actor, order.id, { replacementId: s.items[1].id, originalTo: 'IN_STOCK', warehouseId: s.wh.id }));
  const pending = await transaction((tx) => pendingForCompany(tx, s.companyId));
  assert.deepEqual(pending.map((p) => [p.period, p.amount]), [[unbilled, 20]]);
  assert.deepEqual(pending[0].lines.map((l) => l.itemId), [s.items[1].id]);
  assert.equal(await db.returnedContractItem.count({ where: { contractId: contract.id } }), 0);
});

test('povrat iz servisa na isti ugovor: snimka se briše, pauza i pauzirana razdoblja se čuvaju', async () => {
  const s = await setup();
  const { contract, unbilled } = await rentedOneUnbilled(s);
  const ci = await db.contractItem.findUniqueOrThrow({ where: { itemId: s.items[0].id } });
  await transaction((tx) => updateContractItems(tx, s.actor, contract.id, [ci.id], { status: 'PAUSED' }));
  const since = (await db.contractItem.findUniqueOrThrow({ where: { id: ci.id } })).pausedSince;
  assert.ok(since);
  const order = await newOrder(s, s.items[0].id, true);
  await transaction((tx) => changeServiceStatus(tx, s.actor, order.id, 'REPAIRED'));
  await transaction((tx) => returnDevice(tx, s.actor, order.id, 'RENTED'));
  const back = await db.contractItem.findUniqueOrThrow({ where: { itemId: s.items[0].id } });
  assert.equal(back.status, 'PAUSED');
  assert.equal(back.pausedSince?.getTime(), since.getTime());
  assert.equal(await db.returnedContractItem.count({ where: { contractId: contract.id } }), 0);
  // nastavak: najstarija rata (prije pauze) i dalje se traži, samo jednom
  await transaction((tx) => updateContractItems(tx, s.actor, contract.id, [back.id], { status: null }));
  const pending = await transaction((tx) => pendingForCompany(tx, s.companyId));
  assert.deepEqual(pending.map((p) => p.period), [unbilled]);
});

test('pauza zaostale rate vraćenog uređaja (raspored)', async () => {
  const s = await setup();
  const { contract, unbilled } = await rentedOneUnbilled(s);
  await newOrder(s, s.items[0].id, true); // skinut s ugovora
  assert.equal(await db.contractItem.count({ where: { contractId: contract.id } }), 0);
  await transaction((tx) => setPausedPeriod(tx, s.actor, contract.id, s.items[0].id, unbilled, true));
  assert.deepEqual((await db.returnedContractItem.findFirstOrThrow({ where: { contractId: contract.id } })).paused, [unbilled]);
  assert.equal((await transaction((tx) => pendingForCompany(tx, s.companyId))).length, 0);
  await transaction((tx) => setPausedPeriod(tx, s.actor, contract.id, s.items[0].id, unbilled, false));
  assert.equal((await transaction((tx) => pendingForCompany(tx, s.companyId))).length, 1);
});
