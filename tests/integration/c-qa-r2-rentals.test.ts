/**
 * Područje C — QA krug 2 (najam): plan od budućeg datuma (N1), nova mjesečna cijena
 * ne mijenja prošla ni fakturirana razdoblja (N2), pauza i povrat ne brišu povijest u
 * pregledu najma (N3), KPD za najam na modelu i jasna poruka prije izdavanja eRačuna (N4).
 * npm run test:db
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { changeItemStatus, statusFor, type Actor } from '../../src/server/services/items';
import {
  attachItems, createContract, issuePending, pendingForCompany, setContractStatus, terminateContract, updateContractItems,
} from '../../src/server/services/rentals';
import { invoicedAmounts } from '../../src/server/services/contract-items';
import { saveModel } from '../../src/server/services/settings';
import { loadOverview, readFilters } from '../../src/app/(app)/najam/pregled/data';
import { addDays, addMonths, fromISO, today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
const monthStart = (months: number) => addMonths(today(), months).slice(0, 7) + '-01';
const period = (months: number) => monthStart(months).slice(0, 7);
const cy = Number(today().slice(0, 4));

async function setup(opts: { kpdRent?: string | null; eInvoice?: boolean } = {}) {
  const c = await db.company.create({
    data: {
      name: `CR2 ${Date.now()}-${Math.random()}`, invoicePremises: 'T1', oib: '12345678903', vatRegistered: true,
      kpdRent: opts.kpdRent === undefined ? '77.33.11' : opts.kpdRent, eInvoiceProvider: opts.eInvoice ? 'demo' : 'none',
    },
  });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `cr2${Date.now()}${Math.random()}@t.hr`, name: 'Tester', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20, kpd: '26.20.11' } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const items = [];
  for (let i = 0; i < 2; i++) {
    items.push(
      await db.item.create({
        data: { companyId: c.id, serial: `CR2-${i}`, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2024-01-01') },
      }),
    );
  }
  return { companyId: c.id, actor, wh, partner, items, model };
}

const terms = (startDate: string) => ({
  startDate, endDate: null, firstBillingDate: null, billingDay: 1, billing: 'MONTHLY' as const, billingMode: 'IN_ADVANCE' as const,
  seasonFrom: null, seasonTo: null, note: null,
});

async function contractWith(s: Awaited<ReturnType<typeof setup>>, start: string, monthly: number, n = 1) {
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, s.items.slice(0, n).map((i) => ({ itemId: i.id, monthly })), { issueDate: start }));
  return c;
}

const pending = (s: Awaited<ReturnType<typeof setup>>, contractId: string) =>
  transaction((tx) => pendingForCompany(tx, s.companyId, { contractId })).then((rows) => rows.map((r) => [r.period, r.amount]));

after(async () => {
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

test('N2: nova mjesečna cijena 30 → 60 — fakturirane i prošle neizdane rate ostaju 30, tekuća 60', async () => {
  const s = await setup();
  const c = await contractWith(s, monthStart(-3), 30);
  // izdane rate za prva dva mjeseca; prošli mjesec i tekući nisu izdani
  await transaction((tx) => issuePending(tx, s.actor, [{ contractId: c.id, period: period(-3) }, { contractId: c.id, period: period(-2) }]));
  const ciId = (await db.contractItem.findFirstOrThrow({ where: { contractId: c.id } })).id;
  const r = await transaction((tx) => updateContractItems(tx, s.actor, c.id, [ciId], { monthly: 60 }));
  assert.equal(r.from, monthStart(0));
  const ci = await db.contractItem.findFirstOrThrow({ where: { contractId: c.id } });
  assert.equal(Number(ci.monthly), 60);
  assert.deepEqual(ci.plan, [{ from: monthStart(-3), to: addDays(monthStart(0), -1), price: 30 }, { from: monthStart(0) }]);
  // prošli mjesec (neizdan) po staroj cijeni 30, tekući po novoj 60
  assert.deepEqual(await pending(s, c.id), [[period(-1), 30], [period(0), 60]]);
  // fakturirani mjesec u rasporedu/pregledu: iznos s računa (30)
  const inv = await invoicedAmounts(db, { contractIds: [c.id] }, Number(period(-3).slice(0, 4)));
  assert.equal(inv.get(`${s.items[0].id}|${period(-3)}`), 30);
});

test('N1: plan od prvog dana sljedećeg mjeseca — tekuća neizdana rata ostaje po starim uvjetima', async () => {
  const s = await setup();
  const c = await contractWith(s, monthStart(-3), 30);
  await transaction((tx) => issuePending(tx, s.actor, [-3, -2, -1].map((m) => ({ contractId: c.id, period: period(m) }))));
  const id = (await db.contractItem.findFirstOrThrow({ where: { contractId: c.id } })).id;
  const r = await transaction((tx) => updateContractItems(tx, s.actor, c.id, [id], { plan: [{ from: monthStart(1), billing: 'QUARTERLY' }] }));
  // „vrijedi od" = upisani datum, ne početak tekućeg mjeseca
  assert.equal(r.from, monthStart(1));
  const ci = await db.contractItem.findFirstOrThrow({ where: { id } });
  assert.deepEqual(ci.plan, [{ from: monthStart(-3), to: addDays(monthStart(1), -1) }, { from: monthStart(1), billing: 'QUARTERLY' }]);
  // tekuća rata nije nestala
  assert.deepEqual(await pending(s, c.id), [[period(0), 30]]);
});

test('N3: pauziran ugovor i vraćeni uređaj ostaju u pregledu najma s ratama prije pauze / do povrata', async () => {
  const s = await setup();
  const c = await contractWith(s, monthStart(-3), 10, 2);
  // drugi uređaj vraćen na skladište (skinut s ugovora danas), zatim ugovor pauziran
  await transaction((tx) => changeItemStatus(tx, s.actor, [s.items[1].id], { kind: 'IN_STOCK', data: { warehouseId: s.wh.id }, event: { type: 'RETURNED', message: 'Vraćen' } }));
  assert.equal(await db.returnedContractItem.count({ where: { contractId: c.id } }), 1);
  await transaction((tx) => setContractStatus(tx, s.actor, c.id, 'PAUSED'));
  const { rows, totals } = await loadOverview(s.companyId, readFilters({}), null);
  const byItem = new Map(rows.map((r) => [r.itemId, r]));
  assert.ok(byItem.has(s.items[0].id), 'uređaj pauziranog ugovora je u pregledu');
  assert.ok(byItem.has(s.items[1].id), 'vraćeni uređaj je u pregledu');
  // rate od početka do prošlog mjeseca (odlučene prije pauze) u tekućoj godini, po 10 € po uređaju
  const shown = [-3, -2, -1].filter((m) => Number(period(m).slice(0, 4)) === cy);
  for (const id of [s.items[0].id, s.items[1].id]) {
    const cells = byItem.get(id)!.cells;
    for (const m of shown) assert.equal(cells[Number(period(m).slice(5, 7)) - 1].v, 10, `${id} ${period(m)}`);
  }
  assert.ok(totals.collected >= shown.length * 20);
  // rate prije pauze i dalje se traže (i za vraćeni uređaj)
  const due = await pending(s, c.id);
  assert.ok(due.some(([p, a]) => p === period(-1) && a === 20));
});

test('N4: KPD za najam na modelu (Šifrarnici) — provjera oblika i upis', async () => {
  const s = await setup();
  const base = { brand: 'Sunmi', name: 'T2s', code: null, categoryId: null, kpd: '26.20.11', salePrice: null, rentPrice: 20, marginPct: null, warrantyMonths: null, minStock: 0, specs: null, active: true };
  await assert.rejects(transaction((tx) => saveModel(tx, s.actor, s.model.id, { ...base, kpdRent: '77.3' })), /KPD za najam mora biti oblika/);
  await transaction((tx) => saveModel(tx, s.actor, s.model.id, { ...base, kpdRent: ' 77.39.19 ' }));
  assert.equal((await db.deviceModel.findUniqueOrThrow({ where: { id: s.model.id } })).kpdRent, '77.39.19');
  // prazno briše
  await transaction((tx) => saveModel(tx, s.actor, s.model.id, { ...base, kpdRent: '' }));
  assert.equal((await db.deviceModel.findUniqueOrThrow({ where: { id: s.model.id } })).kpdRent, null);
});

test('N4: rata za B2B eRačun bez KPD-a najma — izdavanje zaustavljeno s porukom što postaviti; s KPD-om na modelu prolazi provjeru', async () => {
  const s = await setup({ kpdRent: null, eInvoice: true });
  const c = await contractWith(s, monthStart(-1), 30);
  await assert.rejects(
    transaction((tx) => issuePending(tx, s.actor, [{ contractId: c.id, period: period(-1) }])),
    /ide kao eRačun, a stavka nema KPD 2025 šifru \(Sunmi T2s\)\. Postavite „KPD za najam" na modelu/,
  );
  // ništa nije izdano (transakcija poništena)
  assert.equal(await db.invoice.count({ where: { companyId: s.companyId, status: 'ISSUED' } }), 0);
  // KPD najma na modelu → stavka rate ga dobiva (ne prodajni 26.20.11)
  await db.deviceModel.update({ where: { id: s.model.id }, data: { kpdRent: '77.39.19' } });
  const res = await transaction((tx) => issuePending(tx, s.actor, [{ contractId: c.id, period: period(-1) }]));
  assert.equal(res.numbers.length, 1);
  const line = await db.invoiceLine.findFirstOrThrow({ where: { invoice: { companyId: s.companyId, contractId: c.id, status: 'ISSUED' } } });
  assert.equal(line.kpd, '77.39.19');
});

test('otkaz prije kraja fakturirane rate: poruka o odobrenju s iznosom', async () => {
  const s = await setup();
  const c = await db.contract.create({
    data: {
      companyId: s.companyId, number: `CR2-${Date.now()}`, partnerId: s.partner.id, status: 'ACTIVE', startDate: fromISO(monthStart(-1)),
      billing: 'QUARTERLY', billingMode: 'IN_ADVANCE', billingDay: 1,
    },
  });
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 30 }], { issueDate: monthStart(-1) }));
  // kvartalna rata prošlog mjeseca pokriva prošli, tekući i sljedeći mjesec
  await transaction((tx) => issuePending(tx, s.actor, [{ contractId: c.id, period: period(-1) }]));
  const r = await transaction((tx) => terminateContract(tx, s.actor, c.id, { returnNow: false }));
  // kraj danas: sljedeći mjesec je fakturiran unaprijed → 1 × 30 €
  assert.deepEqual(r.credit, { months: 1, amount: 30 });
});
