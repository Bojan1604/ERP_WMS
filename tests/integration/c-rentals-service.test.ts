/**
 * Područje C (najam, servis, partneri): brisanje ugovora, ručni broj, „Vrati u
 * izdavanje", skupna sezona/naplata, skupni upis u mrežu najma, brisanje
 * servisnog naloga, ručna PDV kategorija i eRačun adresa partnera.  npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import {
  attachItems, createContract, draftInstallment, issueInstallments, pendingForCompany, skipPending, updateContractItems, updateContractTerms,
  toDevice, toTerms,
} from '../../src/server/services/rentals';
import { deleteContract, setRentOverrides, unskipInstallment } from '../../src/server/services/contract-admin';
import { changeServiceStatus, createServiceOrder, deleteServiceOrder, replaceDevice, returnDevice } from '../../src/server/services/service';
import { savePartner } from '../../src/server/services/partners';
import { invoiceUbl } from '../../src/server/fiscal/ubl-source';
import { devicePlan } from '../../src/domain/billing';
import { addMonths, fromISO, today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup(n = 4) {
  const c = await db.company.create({ data: { name: `C ${Date.now()}-${Math.random()}`, invoicePremises: 'T1', oib: '12345678903', vatRegistered: true } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `c${Date.now()}${Math.random()}@t.hr`, name: 'Tester', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20 } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push(
      await db.item.create({
        data: { companyId: c.id, serial: `CSN${i}`, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2026-01-01') },
      }),
    );
  }
  return { companyId: c.id, actor, wh, partner, items };
}

const terms = (startDate: string) => ({
  startDate, endDate: null, firstBillingDate: null, billingDay: 1, billing: 'MONTHLY' as const, billingMode: 'IN_ADVANCE' as const,
  seasonFrom: null, seasonTo: null, note: null,
});

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

test('ugovor: ručni broj je jedinstven, brisanje samo bez računa, uređaji na skladište ili u povrat', async () => {
  const s = await setup();
  const start = addMonths(today(), -2).slice(0, 7) + '-01';
  const a = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id, number: ' UG 7/2026 ' }));
  assert.equal(a.number, 'UG 7/2026');
  await assert.rejects(transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id, number: 'UG 7/2026' })), /već postoji/);
  const b = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  assert.match(b.number, /\d/);
  // promjena broja postojećem ugovoru, uz provjeru jedinstvenosti
  await assert.rejects(transaction((tx) => updateContractTerms(tx, s.actor, b.id, { ...terms(start), number: 'UG 7/2026' })), /već postoji/);
  await transaction((tx) => updateContractTerms(tx, s.actor, b.id, { ...terms(start), number: 'UG-RUCNI' }));
  assert.equal((await db.contract.findUniqueOrThrow({ where: { id: b.id } })).number, 'UG-RUCNI');

  // ugovor otvoren greškom: uređaji se vraćaju na skladište, prilozi se brišu
  await transaction((tx) => attachItems(tx, s.actor, a.id, [{ itemId: s.items[0].id, monthly: 20 }], { issueDate: start }));
  await db.attachment.create({ data: { companyId: s.companyId, entity: 'contract', entityId: a.id, fileName: 'u.pdf', mime: 'application/pdf', size: 1, data: new Uint8Array([1]) } });
  await transaction((tx) => deleteContract(tx, s.actor, a.id, { warehouseId: s.wh.id }));
  assert.equal(await db.contract.count({ where: { id: a.id } }), 0);
  const i0 = await db.item.findUniqueOrThrow({ where: { id: s.items[0].id }, include: { contractItem: true } });
  assert.equal(i0.state, 'IN_STOCK');
  assert.equal(i0.contractItem, null);
  assert.equal(await db.attachment.count({ where: { entity: 'contract', entityId: a.id } }), 0);
  assert.ok(await db.auditLog.findFirst({ where: { companyId: s.companyId, entity: 'contract', entityId: a.id, action: 'delete' } }));

  // bez skladišta: uređaji su kod klijenta → povrat
  await transaction((tx) => attachItems(tx, s.actor, b.id, [{ itemId: s.items[1].id, monthly: 20 }], { issueDate: start }));
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[2].id, monthly: 20 }], { issueDate: start }));
  await transaction((tx) => deleteContract(tx, s.actor, c.id));
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: s.items[2].id } })).state, 'RETURNING');

  // s izdanim računom (ili nacrtom) brisanje nije dopušteno
  const pending = await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: b.id }));
  assert.ok(pending.length);
  await transaction((tx) => draftInstallment(tx, s.actor, b.id, pending[0].period));
  await assert.rejects(transaction((tx) => deleteContract(tx, s.actor, b.id)), /ima račune/);
  assert.equal(await db.contract.count({ where: { id: b.id } }), 1);

  // tuđa firma ne vidi ugovor
  const other = await setup(0);
  await assert.rejects(transaction((tx) => deleteContract(tx, other.actor, b.id)), /ne postoji/);
});

test('„Vrati u izdavanje": preskočena rata ponovno je za izdati', async () => {
  const s = await setup();
  const start = addMonths(today(), -2).slice(0, 7) + '-01';
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [0, 1].map((i) => ({ itemId: s.items[i].id, monthly: 10 })), { issueDate: start }));
  const before = await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: c.id }));
  const first = before[0];
  await transaction((tx) => skipPending(tx, s.actor, c.id, first.period, first.lines.map((l) => l.itemId)));
  const skipped = await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: c.id }));
  assert.equal(skipped.length, before.length - 1);
  assert.ok(!skipped.some((p) => p.period === first.period));

  const n = await transaction((tx) => unskipInstallment(tx, s.actor, c.id, first.period));
  assert.equal(n, 2);
  const again = await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: c.id }));
  assert.equal(again.length, before.length);
  assert.ok(again.some((p) => p.period === first.period && p.amount === first.amount));
  // već vraćeno razdoblje nema što vratiti
  await assert.rejects(transaction((tx) => unskipInstallment(tx, s.actor, c.id, first.period)), /nije označeno/);
  await assert.rejects(transaction((tx) => unskipInstallment(tx, s.actor, c.id, '2026-13')), /Neispravno/);
});

test('skupno na uređajima ugovora: sezona, naplata i cijena zajedno', async () => {
  const s = await setup();
  // ugovor kreće idući mjesec — izmjena vrijedi za cijeli plan (za prošla razdoblja vidi c-review-fixes)
  const from = addMonths(today(), 1).slice(0, 7) + '-01';
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(from), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, s.items.map((i) => ({ itemId: i.id, monthly: 10 })), { issueDate: today() }));
  const rows = await db.contractItem.findMany({ where: { contractId: c.id }, orderBy: { id: 'asc' } });
  const ids = rows.slice(0, 2).map((r) => r.id);

  // cijena + kvartalno + sezona tra–lis u jednom koraku
  await transaction((tx) => updateContractItems(tx, s.actor, c.id, ids, { monthly: 15, billing: 'QUARTERLY', season: 'summer' }));
  const contract = await db.contract.findUniqueOrThrow({ where: { id: c.id } });
  for (const r of await db.contractItem.findMany({ where: { id: { in: ids } } })) {
    assert.equal(Number(r.monthly), 15);
    const plan = devicePlan(toTerms(contract), toDevice(r));
    assert.equal(plan.length, 1);
    assert.equal(plan[0].billing, 'QUARTERLY');
    assert.deepEqual(plan[0].season, { from: 4, to: 10 });
  }
  // ostali uređaji nepromijenjeni
  const rest = await db.contractItem.findFirstOrThrow({ where: { id: rows[2].id } });
  assert.deepEqual(rest.plan, []);

  // cijela godina: sezona 0 (izričito bez sezone), naplata ostaje kvartalna
  await transaction((tx) => updateContractItems(tx, s.actor, c.id, ids, { season: 'year' }));
  const y = await db.contractItem.findFirstOrThrow({ where: { id: ids[0] } });
  assert.equal(devicePlan(toTerms(contract), toDevice(y))[0].season, null);
  assert.equal(devicePlan(toTerms(contract), toDevice(y))[0].billing, 'QUARTERLY');

  // „kao na ugovoru" vraća uređaj na uvjete ugovora (prazan plan)
  await transaction((tx) => updateContractItems(tx, s.actor, c.id, ids, { season: 'contract' }));
  for (const r of await db.contractItem.findMany({ where: { id: { in: ids } } })) assert.deepEqual(r.plan, []);
  assert.ok(await db.auditLog.findFirst({ where: { companyId: s.companyId, entity: 'contract', action: 'items', summary: { contains: 'sezona' } } }));
});

test('mreža najma: skupni upis i „Auto" (brisanje ručnih upisa)', async () => {
  const s = await setup();
  const other = await setup(1);
  const cells = [0, 1].flatMap((i) => [1, 2, 3].map((month) => ({ itemId: s.items[i].id, month })));
  await db.rentOverride.create({ data: { companyId: s.companyId, itemId: s.items[0].id, year: 2026, month: 1, amount: 5 } });
  const n = await transaction((tx) => setRentOverrides(tx, s.actor, { year: 2026, cells, amount: 12.5 }));
  assert.equal(n, 6);
  const rows = await db.rentOverride.findMany({ where: { companyId: s.companyId, year: 2026 } });
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => Number(r.amount) === 12.5));
  await transaction((tx) => setRentOverrides(tx, s.actor, { year: 2026, cells: cells.slice(0, 3), amount: null }));
  assert.equal(await db.rentOverride.count({ where: { companyId: s.companyId, year: 2026 } }), 3);
  // tuđi uređaj
  await assert.rejects(transaction((tx) => setRentOverrides(tx, s.actor, { year: 2026, cells: [{ itemId: other.items[0].id, month: 1 }], amount: 1 })), /ne postoje/);
});

test('servisni nalog: brisanje samo kad uređaj nije u servisu po njemu i nije zamijenjen', async () => {
  const s = await setup();
  const mk = (itemId: string, setServiceStatus: boolean) =>
    transaction((tx) => createServiceOrder(tx, s.actor, { itemId, issue: 'Ne pali', reportedAt: today(), status: 'RECEIVED', underWarranty: true, setServiceStatus }));

  // prijava bez promjene statusa uređaja — briše se, s fotografijama
  const a = await mk(s.items[0].id, false);
  await db.attachment.create({ data: { companyId: s.companyId, entity: 'serviceOrder', entityId: a.id, fileName: 'f.jpg', mime: 'image/jpeg', size: 1, data: new Uint8Array([1]) } });
  await transaction((tx) => deleteServiceOrder(tx, s.actor, a.id));
  assert.equal(await db.serviceOrder.count({ where: { id: a.id } }), 0);
  assert.equal(await db.attachment.count({ where: { entity: 'serviceOrder', entityId: a.id } }), 0);

  // uređaj je u servisu po nalogu — ni otvoren ni popravljen (čeka povrat) nalog se ne briše
  const b = await mk(s.items[1].id, true);
  await assert.rejects(transaction((tx) => deleteServiceOrder(tx, s.actor, b.id)), /na servisu/);
  await transaction((tx) => changeServiceStatus(tx, s.actor, b.id, 'REPAIRED'));
  await assert.rejects(transaction((tx) => deleteServiceOrder(tx, s.actor, b.id)), /na servisu/);
  await transaction((tx) => returnDevice(tx, s.actor, b.id, 'IN_STOCK', s.wh.id));
  await transaction((tx) => deleteServiceOrder(tx, s.actor, b.id));
  assert.equal(await db.serviceOrder.count({ where: { id: b.id } }), 0);

  // nalog zatvoren zamjenom ne briše se
  const start = addMonths(today(), -1).slice(0, 7) + '-01';
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[2].id, monthly: 20 }], { issueDate: start }));
  const r = await mk(s.items[2].id, false);
  await transaction((tx) => replaceDevice(tx, s.actor, r.id, { replacementId: s.items[3].id, originalTo: 'IN_STOCK', warehouseId: s.wh.id }));
  await assert.rejects(transaction((tx) => deleteServiceOrder(tx, s.actor, r.id)), /zamjenom/);

  const other = await setup(0);
  await assert.rejects(transaction((tx) => deleteServiceOrder(tx, other.actor, r.id)), /ne postoji/);
});

test('partner: ručna PDV kategorija na rati najma, eRačun adresa i poslovnica u UBL-u', async () => {
  const s = await setup();
  const base = {
    name: 'Kupac d.o.o.', oib: '69435151530', vatId: null, address: 'Ilica 1', zip: '10000', city: 'Zagreb', country: 'HR', email: null, phone: null,
    iban: null, contactPerson: null, isCustomer: true, isSupplier: false, excluded: false, paymentTermDays: null, note: null,
  };
  // O ne vrijedi za domaćeg kupca, neispravna adresa se odbija
  await assert.rejects(transaction((tx) => savePartner(tx, s.actor, s.partner.id, { ...base, vatCategoryOverride: 'O' })), /Kategorija O/);
  await assert.rejects(transaction((tx) => savePartner(tx, s.actor, s.partner.id, { ...base, endpointId: 'a b:c/d' })), /eRačun adresa/);
  await transaction((tx) =>
    savePartner(tx, s.actor, s.partner.id, { ...base, vatCategoryOverride: 'ae', endpointId: '0088:5790000435951', branchCode: 'PJ2', branchName: 'Restoran Marina, Split' }),
  );
  const p = await db.partner.findUniqueOrThrow({ where: { id: s.partner.id } });
  assert.equal(p.vatCategoryOverride, 'AE');
  assert.equal(p.endpointId, '0088:5790000435951');
  // izostavljena polja se ne diraju (npr. spremanje iz drugih obrazaca)
  await transaction((tx) => savePartner(tx, s.actor, s.partner.id, { ...base }));
  assert.equal((await db.partner.findUniqueOrThrow({ where: { id: s.partner.id } })).vatCategoryOverride, 'AE');

  const start = addMonths(today(), -1).slice(0, 7) + '-01';
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 20 }], { issueDate: start }));
  const pending = await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: c.id }));
  const [number] = await transaction((tx) => issueInstallments(tx, s.actor, [{ contractId: c.id, period: pending[0].period }]));
  const inv = await db.invoice.findFirstOrThrow({ where: { companyId: s.companyId, number } });
  // domaći kupac, ali ručno prijenos porezne obveze: bez PDV-a
  assert.equal(inv.taxCategory, 'AE');
  assert.equal(Number(inv.vatRate), 0);
  assert.equal(Number(inv.vatTotal ?? 0), 0);

  const ubl = await invoiceUbl(s.companyId, inv.id);
  assert.ok(ubl?.xml);
  const customer = ubl.xml.split('<cac:AccountingCustomerParty>')[1].split('</cac:AccountingCustomerParty>')[0];
  assert.match(customer, /<cbc:EndpointID schemeID="0088">5790000435951<\/cbc:EndpointID>/);
  assert.match(customer, /<cac:PartyIdentification><cbc:ID>9934:69435151530::HR99:PJ2<\/cbc:ID><\/cac:PartyIdentification>/);
  assert.match(customer, /<cbc:Name>Restoran Marina, Split<\/cbc:Name>/);
  assert.match(ubl.xml, /<cac:TaxCategory><cbc:ID>AE<\/cbc:ID>/);

  // bez ručne adrese domaći kupac nosi OIB u shemi 9934
  await transaction((tx) => savePartner(tx, s.actor, s.partner.id, { ...base, endpointId: null, vatCategoryOverride: null, branchCode: null, branchName: null }));
  const again = await invoiceUbl(s.companyId, inv.id);
  const cust2 = again!.xml!.split('<cac:AccountingCustomerParty>')[1];
  assert.match(cust2, /<cbc:EndpointID schemeID="9934">69435151530<\/cbc:EndpointID>/);
  assert.doesNotMatch(cust2.split('</cac:AccountingCustomerParty>')[0], /PartyIdentification/);
});
