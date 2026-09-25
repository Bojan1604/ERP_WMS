/**
 * Područje C — ispravci QA t2 (najam): izmjena uvjeta ugovora i plana uređaja ne
 * otvara izdana/pauzirana razdoblja, datum i serija računa rate, KPD za najam,
 * numeriranje ugovora preskače ručne brojeve, „Pokreni sada" bez uključene opcije,
 * rate prije pauze, datum izdavanja uređaja koji je već kod klijenta.  npm run test:db
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import {
  attachItems, createContract, draftInstallment, issuePending, pendingForCompany, setContractStatus, updateContractItems, updateContractTerms,
} from '../../src/server/services/rentals';
import { autoIssueCompany } from '../../src/server/jobs/auto-issue';
import { addMonths, fromISO, toISO, today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
const monthStart = (months: number) => addMonths(today(), months).slice(0, 7) + '-01';
const year = Number(today().slice(0, 4));

async function setup(n = 3) {
  const c = await db.company.create({ data: { name: `CQ ${Date.now()}-${Math.random()}`, invoicePremises: 'T1', oib: '12345678903', vatRegistered: true, kpdRent: '77.33.11' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `cq${Date.now()}${Math.random()}@t.hr`, name: 'Tester', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20, warrantyMonths: 24, kpd: '46.51.10' } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push(
      await db.item.create({
        data: { companyId: c.id, serial: `CQ${i}`, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2024-01-01') },
      }),
    );
  }
  return { companyId: c.id, actor, wh, partner, items, model };
}

const terms = (startDate: string, billing: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' = 'MONTHLY') => ({
  startDate, endDate: null, firstBillingDate: null, billingDay: 1, billing, billingMode: 'IN_ADVANCE' as const,
  seasonFrom: null, seasonTo: null, note: null,
});

async function issue(s: Awaited<ReturnType<typeof setup>>, contractId: string, periods?: string[]) {
  const rows = (await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId }))).filter((r) => !periods || periods.includes(r.period));
  if (rows.length) await transaction((tx) => issuePending(tx, s.actor, rows.map((r) => ({ contractId, period: r.period }))));
  return rows.map((r) => r.period);
}

after(async () => {
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

test('#1 uvjeti ugovora godišnje → mjesečno ne otvaraju mjesece koje je pokrila godišnja rata', async () => {
  const s = await setup(1);
  const start = monthStart(-8);
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start, 'ANNUAL'), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 10 }], { issueDate: start }));
  assert.equal((await issue(s, c.id)).length, 1);
  const r = await transaction((tx) => updateContractTerms(tx, s.actor, c.id, terms(start, 'MONTHLY')));
  assert.equal(r.from, monthStart(4));
  assert.deepEqual(await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: c.id })), []);
  const ci = await db.contractItem.findFirstOrThrow({ where: { contractId: c.id } });
  const plan = ci.plan as Array<{ from: string; to?: string; billing?: string }>;
  assert.equal(plan[0].billing, 'ANNUAL');
  assert.equal(plan[1].from, monthStart(4));
  assert.ok(await db.auditLog.findFirst({ where: { companyId: s.companyId, entity: 'contract', action: 'update', summary: { contains: 'vrijedi od' } } }));
});

test('#2 plan uređaja kvartalno → mjesečno: plaćeni i pauzirani mjeseci ostaju zatvoreni', async () => {
  const s = await setup(1);
  const start = monthStart(-7);
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start, 'QUARTERLY'), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 10 }], { issueDate: start }));
  // prvi kvartal izdan, drugi pauziran, treći neizdan
  await issue(s, c.id, [start.slice(0, 7)]);
  const ci = await db.contractItem.findFirstOrThrow({ where: { contractId: c.id } });
  await db.contractItem.update({ where: { id: ci.id }, data: { paused: [monthStart(-4).slice(0, 7)] } });
  const r = await transaction((tx) => updateContractItems(tx, s.actor, c.id, [ci.id], { plan: [{ from: start, billing: 'MONTHLY' }] }));
  assert.equal(r.from, monthStart(2));
  const pending = await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: c.id }));
  assert.deepEqual(pending.map((p) => [p.period, p.amount]), [[monthStart(-1).slice(0, 7), 30]]);
  const after = await db.contractItem.findUniqueOrThrow({ where: { id: ci.id } });
  assert.deepEqual(after.paused, [monthStart(-4).slice(0, 7)]);
});

test('#3 rata iz prošle godine: datum računa danas, serija tekuće godine; razdoblje ostaje', async () => {
  const s = await setup(1);
  const start = `${year - 1}-12-01`;
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 10 }], { issueDate: start }));
  // nacrt otvoren „Pregledaj" ranije (stari datum) izdaje se s današnjim datumom
  const draft = await transaction((tx) => draftInstallment(tx, s.actor, c.id, `${year - 1}-12`));
  assert.equal(toISO(draft.date), today());
  await db.invoice.update({ where: { id: draft.id }, data: { date: fromISO(`${year - 1}-12-01`), year: year - 1 } });
  await transaction((tx) => issuePending(tx, s.actor, [{ contractId: c.id, period: `${year - 1}-12` }]));
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: draft.id }, include: { lines: true } });
  assert.equal(toISO(inv.date), today());
  assert.equal(inv.year, year);
  assert.equal(inv.period, `${year - 1}-12`);
  // #8 KPD: zadani KPD za najam firme ima prednost pred prodajnim KPD-om modela
  assert.equal(inv.lines[0].kpd, '77.33.11');
  assert.equal(inv.lines[0].unit, 'kom');
});

test('#6 automatski broj ugovora preskače ručno upisan (i bez obzira na velika/mala slova)', async () => {
  const s = await setup(0);
  const t = terms(`${year}-01-01`);
  const a = await transaction((tx) => createContract(tx, s.actor, { ...t, partnerId: s.partner.id }));
  const seq = Number(a.number.split('-').at(-1));
  const next = a.number.replace(/\d+$/, (m) => String(seq + 1).padStart(m.length, '0'));
  const manual = await transaction((tx) => createContract(tx, s.actor, { ...t, partnerId: s.partner.id, number: next }));
  assert.equal(manual.number, next);
  const auto = await transaction((tx) => createContract(tx, s.actor, { ...t, partnerId: s.partner.id }));
  assert.notEqual(auto.number, next);
  assert.equal(auto.number, a.number.replace(/\d+$/, (m) => String(seq + 2).padStart(m.length, '0')));
  await assert.rejects(transaction((tx) => createContract(tx, s.actor, { ...t, partnerId: s.partner.id, number: next.toLowerCase() })), /već postoji/);
  // ručni broj malim slovima zauzima i automatski
  const lower = a.number.replace(/\d+$/, (m) => String(seq + 3).padStart(m.length, '0')).toLowerCase();
  await transaction((tx) => createContract(tx, s.actor, { ...t, partnerId: s.partner.id, number: lower }));
  const auto2 = await transaction((tx) => createContract(tx, s.actor, { ...t, partnerId: s.partner.id }));
  assert.equal(auto2.number, a.number.replace(/\d+$/, (m) => String(seq + 4).padStart(m.length, '0')));
});

test('#7 „Pokreni sada" bez uključenog automatskog izdavanja odbija i ne upisuje datum', async () => {
  const s = await setup(1);
  const start = monthStart(-1);
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 10 }], { issueDate: start }));
  await assert.rejects(autoIssueCompany(s.companyId, { force: true, fiscalize: false }), /nije uključeno/);
  const co = await db.company.findUniqueOrThrow({ where: { id: s.companyId } });
  assert.equal(co.autoIssueSince, null);
  assert.equal(await db.invoice.count({ where: { companyId: s.companyId, status: 'ISSUED' } }), 0);
});

test('#10 pauziran ugovor: rate od prije pauze ostaju u „Rate za izdati"', async () => {
  const s = await setup(1);
  const start = monthStart(-3);
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 10 }], { issueDate: start }));
  await issue(s, c.id, [start.slice(0, 7)]);
  await transaction((tx) => setContractStatus(tx, s.actor, c.id, 'PAUSED'));
  const pending = await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: c.id }));
  // dva prošla mjeseca prije pauze i tekući (rata 1. u mjesecu, pauza danas — osim ako je danas 1.)
  const expected = [monthStart(-2), monthStart(-1), ...(today().endsWith('-01') ? [] : [monthStart(0)])].map((d) => d.slice(0, 7));
  assert.deepEqual(pending.map((p) => p.period), expected);
  await issue(s, c.id, [expected[0]]);
  assert.equal(await db.invoice.count({ where: { contractId: c.id, status: 'ISSUED' } }), 2);
});

test('#11 uređaj koji je već kod klijenta zadržava datum izdavanja i jamstva', async () => {
  const s = await setup(1);
  const rented = await transaction((tx) => statusFor(tx, s.companyId, 'RENTED'));
  await db.item.update({
    where: { id: s.items[0].id },
    data: { state: 'RENTED', statusId: rented.id, partnerId: s.partner.id, warehouseId: null, issueDate: fromISO('2024-05-05'), warrantyStart: fromISO('2024-05-05') },
  });
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(monthStart(0)), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 10 }]));
  const it = await db.item.findUniqueOrThrow({ where: { id: s.items[0].id } });
  assert.equal(toISO(it.issueDate), '2024-05-05');
  assert.equal(toISO(it.warrantyStart), '2024-05-05');
});
