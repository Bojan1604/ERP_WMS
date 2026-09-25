/**
 * QA t4 (servis, partneri, portal): izvorni račun uređaja ne priječi brisanje naloga,
 * otpis po nalogu se ne poništava ponovnim otvaranjem, dijagnoza nije na nalogu za
 * dostavu klijentu, jamstvo uređaja partnera kao na portalu, otpisani nisu „kod partnera".
 * npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { attachItems, createContract, issuePending, pendingForCompany } from '../../src/server/services/rentals';
import { changeServiceStatus, createServiceOrder, deleteServiceOrder, replaceDevice } from '../../src/server/services/service';
import { savePartner, type PartnerInput } from '../../src/server/services/partners';
import { partnerCounts, partnerDevices, partnerStats, partnerWhere } from '../../src/server/queries/partners';
import { serviceWhere } from '../../src/server/queries/service';
import { documentDefinitionFor } from '../../src/server/pdf';
import { addMonths, fromISO, today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup(n = 3) {
  const c = await db.company.create({ data: { name: `QA4 ${Date.now()}-${Math.random()}`, invoicePremises: 'T1', oib: '12345678903', vatRegistered: true } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `q${Date.now()}${Math.random()}@t.hr`, name: 'Tester', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20, warrantyMonths: 24 } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530' } });
  const st = async (k: 'IN_STOCK' | 'SOLD' | 'WRITTEN_OFF') => (await transaction((tx) => statusFor(tx, c.id, k))).id;
  const statuses = { IN_STOCK: await st('IN_STOCK'), SOLD: await st('SOLD'), WRITTEN_OFF: await st('WRITTEN_OFF') };
  const items: Array<{ id: string }> = [];
  for (let i = 0; i < n; i++) {
    items.push(
      await db.item.create({
        data: { companyId: c.id, serial: `QSN${i}`, modelId: model.id, statusId: statuses.IN_STOCK, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2026-01-01') },
      }),
    );
  }
  const sold = (i: number) =>
    db.item.update({ where: { id: items[i].id }, data: { state: 'SOLD', statusId: statuses.SOLD, partnerId: partner.id, warehouseId: null, issueDate: fromISO('2026-01-10') } });
  return { companyId: c.id, actor, wh, partner, items, sold, statuses };
}

const open = (s: Awaited<ReturnType<typeof setup>>, itemId: string, status: 'REPORTED' | 'RECEIVED' = 'RECEIVED') =>
  transaction((tx) => createServiceOrder(tx, s.actor, { itemId, issue: 'Ne pali', reportedAt: today(), status, underWarranty: true, setServiceStatus: false }));

const monthStart = (d: number) => addMonths(today(), d).slice(0, 7) + '-01';

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

test('QA1: nalog s izvornim računom uređaja (izdana rata najma) može se obrisati', async () => {
  const s = await setup(1);
  const start = monthStart(-1);
  const c = await transaction((tx) =>
    createContract(tx, s.actor, { startDate: start, endDate: null, firstBillingDate: null, billingDay: 1, billing: 'MONTHLY', billingMode: 'IN_ADVANCE', seasonFrom: null, seasonTo: null, note: null, partnerId: s.partner.id }),
  );
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 10 }], { issueDate: start }));
  await transaction(async (tx) => issuePending(tx, s.actor, [{ contractId: c.id, period: (await pendingForCompany(tx, s.companyId, { contractId: c.id }))[0].period }]));
  const item = await db.item.findUniqueOrThrow({ where: { id: s.items[0].id } });
  assert.ok(item.invoiceId, 'uređaj ima račun');
  const o = await open(s, item.id);
  const row = await db.serviceOrder.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(row.invoiceId, item.invoiceId, 'nalog pamti izvorni račun uređaja (za prikaz)');
  await transaction((tx) => deleteServiceOrder(tx, s.actor, o.id));
  assert.equal(await db.serviceOrder.count({ where: { id: o.id } }), 0);
  assert.equal(await db.invoice.count({ where: { id: item.invoiceId! } }), 1);
});

test('QA2: otpis uređaja po nalogu — nalog se ne otvara ponovno ni ne briše', async () => {
  const s = await setup(2);
  await s.sold(0);
  const o = await open(s, s.items[0].id);
  await transaction((tx) => changeServiceStatus(tx, s.actor, o.id, 'WRITTEN_OFF', { writeOffDevice: true, note: 'neisplativo' }));
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: s.items[0].id } })).state, 'WRITTEN_OFF');
  await assert.rejects(transaction((tx) => changeServiceStatus(tx, s.actor, o.id, 'RECEIVED')), /otpisan je po ovom nalogu/);
  // i kad bi nalog nekako bio vraćen (stari podaci), povijest uređaja priječi brisanje
  await db.serviceOrder.update({ where: { id: o.id }, data: { status: 'RECEIVED' } });
  await assert.rejects(transaction((tx) => deleteServiceOrder(tx, s.actor, o.id)), /uređaj je otpisan/);

  // otpis samo naloga (uređaj nije otpisan) — nalog se smije ponovno otvoriti
  await s.sold(1);
  const b = await open(s, s.items[1].id);
  await transaction((tx) => changeServiceStatus(tx, s.actor, b.id, 'WRITTEN_OFF'));
  await transaction((tx) => changeServiceStatus(tx, s.actor, b.id, 'RECEIVED'));
  assert.equal((await db.serviceOrder.findUniqueOrThrow({ where: { id: b.id } })).status, 'RECEIVED');
});

test('QA3: nalog za dostavu (PDF) bez dijagnoze i poduzetog — rješenje i poruka klijentu ostaju', async () => {
  const s = await setup(1);
  await s.sold(0);
  const o = await open(s, s.items[0].id);
  await db.serviceOrder.update({
    where: { id: o.id },
    data: { status: 'REPAIRED', closedAt: new Date(), diagnosis: 'INTERNA-DIJAGNOZA', action: 'INTERNO-POSLANO-DOBAVLJACU', solution: 'Zamijenjeno napajanje', publicNote: 'Hvala na strpljenju' },
  });
  const def = (await documentDefinitionFor('service-delivery', o.id, s.companyId)).def;
  const text = JSON.stringify(def.content);
  assert.doesNotMatch(text, /INTERNA-DIJAGNOZA|INTERNO-POSLANO/);
  assert.match(text, /Zamijenjeno napajanje/);
  assert.match(text, /Hvala na strpljenju/);
});

test('QA4/9: uređaji partnera — jamstvo od izdavanja + trajanje modela, otpisani se ne broje', async () => {
  const s = await setup(3);
  // uređaj bez vlastitog početka i trajanja jamstva (npr. u najmu): izdavanje + 24 mj. modela
  await s.sold(0);
  await s.sold(1);
  await db.item.update({ where: { id: s.items[1].id }, data: { state: 'WRITTEN_OFF', statusId: s.statuses.WRITTEN_OFF } });
  const { rows, total } = await partnerDevices(s.companyId, s.partner.id);
  assert.equal(total, 1);
  assert.equal(rows[0].id, s.items[0].id);
  assert.equal(rows[0].warrantyEnd, '2028-01-10');
  assert.equal((await partnerCounts(s.companyId, s.partner.id)).devices, 1);
  assert.equal((await partnerStats(s.companyId, [s.partner.id])).get(s.partner.id)!.devices, 1);
});

test('QA10: zamjena iz „Prijavljeno" postavlja datum zaprimanja', async () => {
  const s = await setup(2);
  await s.sold(0);
  const o = await open(s, s.items[0].id, 'REPORTED');
  await transaction((tx) => replaceDevice(tx, s.actor, o.id, { replacementId: s.items[1].id, originalTo: 'IN_STOCK', warehouseId: s.wh.id }));
  const row = await db.serviceOrder.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(row.status, 'REPLACED');
  assert.ok(row.receivedAt);
});

test('QA7/10: naziv jedinice bez šifre se odbija; % i _ u pretrazi su doslovni', async () => {
  const s = await setup(1);
  const base: PartnerInput = {
    name: 'Abc Test', oib: null, vatId: null, address: null, zip: null, city: null, country: 'HR', email: null, phone: null, iban: null, contactPerson: null,
    isCustomer: true, isSupplier: false, excluded: false, paymentTermDays: null, note: null,
  };
  await assert.rejects(transaction((tx) => savePartner(tx, s.actor, null, { ...base, branchCode: '', branchName: 'Restoran Marina' })), /šifru poslovne jedinice/);
  const id = await transaction((tx) => savePartner(tx, s.actor, null, { ...base, branchCode: 'PJ1', branchName: 'Restoran Marina' }));
  assert.equal((await db.partner.findUniqueOrThrow({ where: { id } })).branchName, 'Restoran Marina');

  const count = (q: string) => db.partner.count({ where: partnerWhere(s.companyId, { q }) });
  assert.equal(await count('%'), 0);
  assert.equal(await count('A_c'), 0);
  assert.equal(await count('Abc'), 1);
  await s.sold(0);
  await open(s, s.items[0].id);
  const orders = (q: string) => db.serviceOrder.count({ where: { AND: [{ companyId: s.companyId }, serviceWhere(s.companyId, { q, scope: 'all' })] } });
  assert.equal(await orders('%'), 0);
  assert.equal(await orders('QSN0'), 1);
});
