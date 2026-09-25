/**
 * Područje C — ispravci revizije: skupna naplata/sezona ne otvara izdana i prošla
 * razdoblja, istodobno izdavanje iste rate, brisanje servisnog naloga i ugovora,
 * popis uređaja klijenta, zbrojevi popisa ugovora, pristup portalu.  npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { changeItemStatus, statusFor, type Actor } from '../../src/server/services/items';
import {
  attachItems, createContract, issuePending, pendingForCompany, removeFromContract, updateContractItems,
} from '../../src/server/services/rentals';
import { deleteContract } from '../../src/server/services/contract-admin';
import { changeServiceStatus, createServiceOrder, deleteServiceOrder } from '../../src/server/services/service';
import { clientSheet } from '../../src/server/queries/client-sheet';
import { listContracts } from '../../src/server/queries/contract-list';
import { createPortalUser } from '../../src/server/portal/users';
import { addMonths, fromISO, today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
const monthStart = (months: number) => addMonths(today(), months).slice(0, 7) + '-01';

async function setup(n = 4) {
  const c = await db.company.create({ data: { name: `CR ${Date.now()}-${Math.random()}`, invoicePremises: 'T1', oib: '12345678903', vatRegistered: true } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `cr${Date.now()}${Math.random()}@t.hr`, name: 'Tester', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20, warrantyMonths: 24 } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push(
      await db.item.create({
        data: { companyId: c.id, serial: `CR${i}`, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2024-01-01') },
      }),
    );
  }
  return { companyId: c.id, actor, wh, partner, items, model };
}

const terms = (startDate: string, billing: 'MONTHLY' | 'ANNUAL' = 'MONTHLY') => ({
  startDate, endDate: null, firstBillingDate: null, billingDay: 1, billing, billingMode: 'IN_ADVANCE' as const,
  seasonFrom: null, seasonTo: null, note: null,
});

async function issueAll(s: Awaited<ReturnType<typeof setup>>, contractId: string) {
  const rows = await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId }));
  if (rows.length) await transaction((tx) => issuePending(tx, s.actor, rows.map((r) => ({ contractId, period: r.period }))));
  return rows.length;
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

test('skupno godišnja → mjesečna: izdana godišnja rata ne otvara mjesece koje pokriva', async () => {
  const s = await setup(1);
  const start = monthStart(-8);
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start, 'ANNUAL'), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 10 }], { issueDate: start }));
  assert.equal(await issueAll(s, c.id), 1);
  const [ci] = await db.contractItem.findMany({ where: { contractId: c.id } });
  await transaction((tx) => updateContractItems(tx, s.actor, c.id, [ci.id], { billing: 'MONTHLY' }));
  assert.deepEqual(await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: c.id })), []);
  const plan = (await db.contractItem.findUniqueOrThrow({ where: { id: ci.id } })).plan as Array<{ from: string; billing?: string }>;
  assert.equal(plan.length, 2);
  assert.equal(plan[1].from, monthStart(4));
  assert.equal(plan[1].billing, 'MONTHLY');
  assert.ok(await db.auditLog.findFirst({ where: { companyId: s.companyId, entity: 'contract', action: 'items', summary: { contains: 'vrijedi od' } } }));
});

test('skupno sezonski → cijela godina: prošli mjeseci izvan sezone ne postaju rate', async () => {
  const s = await setup(1);
  const start = monthStart(-14);
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) =>
    attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 10, plan: [{ from: start, seasonFrom: 4, seasonTo: 10 }] }], { issueDate: start }),
  );
  await issueAll(s, c.id);
  const [ci] = await db.contractItem.findMany({ where: { contractId: c.id } });
  await transaction((tx) => updateContractItems(tx, s.actor, c.id, [ci.id], { season: 'year' }));
  const pending = await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: c.id }));
  const current = today().slice(0, 7);
  assert.ok(pending.every((p) => p.period >= current), `prošla razdoblja ponovno za izdati: ${pending.map((p) => p.period).join(', ')}`);
});

test('istodobno izdavanje iste rate (dvije transakcije) izdaje jedan račun', async () => {
  const s = await setup(1);
  const start = monthStart(-1);
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 10 }], { issueDate: start }));
  const [row] = await transaction((tx) => pendingForCompany(tx, s.companyId, { contractId: c.id }));
  const once = () => transaction((tx) => issuePending(tx, s.actor, [{ contractId: c.id, period: row.period }]));
  const res = await Promise.allSettled([once(), once()]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(failed.reason?.message), /nema rate za izdati/);
  assert.equal(await db.invoice.count({ where: { contractId: c.id, period: row.period, status: 'ISSUED' } }), 1);
});

test('servisni nalog: otpisan se ne briše; izvorni račun uređaja ne priječi brisanje', async () => {
  const s = await setup(2);
  const mk = (itemId: string) =>
    transaction((tx) => createServiceOrder(tx, s.actor, { itemId, issue: 'Ne pali', reportedAt: today(), status: 'RECEIVED', underWarranty: false, setServiceStatus: false }));
  const a = await mk(s.items[0].id);
  await transaction((tx) => changeServiceStatus(tx, s.actor, a.id, 'WRITTEN_OFF'));
  await assert.rejects(transaction((tx) => deleteServiceOrder(tx, s.actor, a.id)), /otpisom/);

  // invoiceId naloga je račun uređaja (rata najma), ne račun izdan iz naloga — brisanje prolazi, račun ostaje
  const start = monthStart(-1);
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[1].id, monthly: 10 }], { issueDate: start }));
  await transaction(async (tx) => issuePending(tx, s.actor, [{ contractId: c.id, period: (await pendingForCompany(tx, s.companyId, { contractId: c.id }))[0].period }]));
  const b = await mk(s.items[1].id);
  const bo = await db.serviceOrder.findUniqueOrThrow({ where: { id: b.id } });
  assert.ok(bo.invoiceId, 'nalog pamti izvorni račun uređaja');
  await transaction((tx) => deleteServiceOrder(tx, s.actor, b.id));
  assert.equal(await db.serviceOrder.count({ where: { id: { in: [a.id, b.id] } } }), 1);
  assert.equal(await db.invoice.count({ where: { id: bo.invoiceId! } }), 1);
});

test('brisanje ugovora: uređaji u povratu idu na skladište, ručni iznosi najma se brišu', async () => {
  const s = await setup(2);
  const start = monthStart(-1);
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, s.items.map((i) => ({ itemId: i.id, monthly: 10 })), { issueDate: start }));
  const cis = await db.contractItem.findMany({ where: { contractId: c.id, itemId: s.items[1].id } });
  await transaction((tx) => removeFromContract(tx, s.actor, c.id, cis.map((r) => r.id)));
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  await db.rentOverride.create({ data: { companyId: s.companyId, itemId: s.items[0].id, year: y, month: m, amount: 7 } });
  await db.rentOverride.create({ data: { companyId: s.companyId, itemId: s.items[0].id, year: y - 2, month: 1, amount: 7 } });
  const r = await transaction((tx) => deleteContract(tx, s.actor, c.id, { warehouseId: s.wh.id }));
  assert.equal(r.returned, 2);
  for (const i of s.items) assert.equal((await db.item.findUniqueOrThrow({ where: { id: i.id } })).state, 'IN_STOCK');
  // ostaje samo upis iz vremena prije ugovora
  assert.equal(await db.rentOverride.count({ where: { itemId: s.items[0].id } }), 1);
});

test('popis uređaja klijenta: prodano = prodani uređaji, jamstvo iz modela, zbrojevi iz baze', async () => {
  const s = await setup(0);
  const sold = await transaction((tx) => statusFor(tx, s.companyId, 'SOLD'));
  const reserved = await transaction((tx) => statusFor(tx, s.companyId, 'RESERVED'));
  const issue = fromISO('2026-01-10');
  for (let i = 0; i < 3; i++) {
    await db.item.create({
      data: { companyId: s.companyId, serial: `S${i}`, modelId: s.model.id, statusId: sold.id, state: 'SOLD', partnerId: s.partner.id, salePrice: 100, issueDate: issue },
    });
  }
  await db.item.create({ data: { companyId: s.companyId, serial: 'R1', modelId: s.model.id, statusId: reserved.id, state: 'RESERVED', partnerId: s.partner.id, salePrice: 50 } });
  const page = await clientSheet(s.companyId, s.partner.id, { view: 'prodano', limit: 2 });
  assert.ok(page);
  assert.equal(page.counts.prodano, 3);
  assert.equal(page.rows.length, 2);
  assert.ok(page.truncated);
  // zbroj za cijeli pogled, ne samo prikazane retke
  assert.equal(page.sales, 300);
  // jamstvo bez početka jamstva: od izdavanja, trajanje iz modela
  assert.equal(page.rows[0].warrantyEnd, '2028-01-10');
  const all = await clientSheet(s.companyId, s.partner.id, { view: 'prodano', limit: null });
  assert.equal(all?.rows.length, 3);
  assert.ok(!all?.truncated);
});

test('popis ugovora: skinuti uređaji ulaze u obračun, podnožje zbraja stupac', async () => {
  const s = await setup(2);
  const start = `${today().slice(0, 4)}-01-01`;
  const c = await transaction((tx) => createContract(tx, s.actor, { ...terms(start), partnerId: s.partner.id }));
  await transaction((tx) => attachItems(tx, s.actor, c.id, s.items.map((i) => ({ itemId: i.id, monthly: 10 })), { issueDate: start }));
  const before = await listContracts(s.companyId, { pogled: 'svi' }, { skip: 0, take: 10 });
  const b0 = before.rows.find((r) => r.id === c.id)!;
  assert.equal(b0.devices, 2);
  assert.equal(b0.accrual, 240);
  // uređaj skinut danas: obračun do danas ostaje u godini
  await transaction((tx) => changeItemStatus(tx, s.actor, [s.items[1].id], { kind: 'IN_STOCK', data: { warehouseId: s.wh.id }, event: { type: 'RETURNED', message: 'test' } }));
  const after = await listContracts(s.companyId, { pogled: 'svi' }, { skip: 0, take: 10 });
  const a0 = after.rows.find((r) => r.id === c.id)!;
  assert.equal(a0.devices, 1);
  assert.equal(a0.monthly, 10);
  const month = Number(today().slice(5, 7));
  assert.equal(a0.accrual, 120 + 10 * month);
  // pauziran ugovor: stupac „Mjesečno" i podnožje isti zbroj
  await db.contract.update({ where: { id: c.id }, data: { status: 'PAUSED' } });
  const paused = await listContracts(s.companyId, { pogled: 'svi' }, { skip: 0, take: 10 });
  assert.equal(paused.summary.monthly, 0);
  assert.equal(paused.summary.monthlyAll, 10);
});

test('pristup portalu: adresa iz druge firme — poruka ne otkriva da postoji', async () => {
  const a = await setup(0);
  const b = await setup(0);
  const email = `p${Date.now()}${Math.random()}@t.hr`.toLowerCase();
  await transaction((tx) => createPortalUser(tx, a.actor, { partnerId: a.partner.id, name: null, email }));
  await assert.rejects(transaction((tx) => createPortalUser(tx, a.actor, { partnerId: a.partner.id, name: null, email })), /već ima pristup/);
  await assert.rejects(
    transaction((tx) => createPortalUser(tx, b.actor, { partnerId: b.partner.id, name: null, email })),
    (e: Error) => /ne može se koristiti/.test(e.message) && !/već ima/.test(e.message),
  );
});
