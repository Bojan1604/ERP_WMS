/**
 * Fiskalizacija nad testnom bazom: ZKI pri izdavanju, demo CIS i demo eRačun
 * nakon transakcije, blokada izdavanja kad nedostaje OIB operatera.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { Actor } from '../../src/server/services/items';
import { createDraft, issueInvoice, stornoInvoice } from '../../src/server/services/invoices';
import { afterIssue, fiscalizeInvoice, retryPending, sendEInvoice } from '../../src/server/fiscal';
import { claimSend, CLAIM_STALE_MS } from '../../src/server/fiscal/claim';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');
process.env.AUTH_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';

const OIB = '12345678903';
const companies: string[] = [];

async function setup(opts: { operatorOib?: string | null } = {}) {
  const c = await db.company.create({
    // zadane KPD šifre: eRačun (B2B) se bez KPD-a na svakoj stavci ne izdaje (HR-BR-25)
    data: { name: `Fisk ${Date.now()}-${Math.random()}`, oib: OIB, invoicePremises: 'PP1', invoiceDevice: '1', fiscalEnabled: true, fiscalEnv: 'TEST', eInvoiceProvider: 'demo', kpdSale: '26.20.11', kpdService: '62.90.10' },
  });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({
    data: { companyId: c.id, email: `f${Date.now()}${Math.random()}@t.hr`, name: 'Blagajnik', passwordHash: 'x', role: 'ADMIN', oib: opts.operatorOib === undefined ? OIB : opts.operatorOib },
  });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const citizen = await db.partner.create({ data: { companyId: c.id, name: 'Ivo Ivić' } });
  const business = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530' } });
  return { companyId: c.id, actor, citizen, business };
}

const draft = (s: Awaited<ReturnType<typeof setup>>, partnerId: string, paymentMethod: 'CASH' | 'TRANSFER' | 'CARD', date = '2026-03-01') =>
  transaction((tx) =>
    createDraft(tx, s.actor, { type: 'SERVICE', partnerId, date, vatRate: 25, paymentMethod, lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 100 }] }),
  );

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

test('gotovina: ZKI pri izdavanju, demo JIR nakon transakcije, storno nasljeđuje način plaćanja', async () => {
  const s = await setup();
  const d = await draft(s, s.business.id, 'CASH');
  await transaction((tx) => issueInvoice(tx, s.actor, d.id));
  let inv = await db.invoice.findUniqueOrThrow({ where: { id: d.id } });
  assert.match(inv.zki ?? '', /^[0-9a-f]{32}$/);
  assert.equal(inv.fiscalStatus, 'PENDING');
  assert.equal(inv.jir, null);
  assert.equal(inv.issuedAt!.getMilliseconds(), 0);

  const o = await afterIssue(d.id, s.actor);
  assert.ok(o?.ok, o?.message);
  inv = await db.invoice.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(inv.fiscalStatus, 'SENT');
  assert.match(inv.jir ?? '', /^[0-9a-f-]{36}$/);
  const logs = await db.fiscalLog.findMany({ where: { invoiceId: d.id } });
  assert.equal(logs.length, 1);
  assert.match(logs[0].request ?? '', /\[DEMO[\s\S]*<tns:NacinPlac>G<\/tns:NacinPlac>[\s\S]*<tns:OibOper>12345678903<\/tns:OibOper>/);

  const st = await transaction((tx) => stornoInvoice(tx, s.actor, d.id, { date: '2026-03-02' }));
  const sinv = await db.invoice.findUniqueOrThrow({ where: { id: st.id } });
  assert.equal(sinv.paymentMethod, 'CASH');
  assert.match(sinv.zki ?? '', /^[0-9a-f]{32}$/);
});

test('transakcijski račun poslovnom subjektu → demo eRačun; krajnjem kupcu → CIS', async () => {
  const s = await setup();
  const b2b = await draft(s, s.business.id, 'TRANSFER');
  await transaction((tx) => issueInvoice(tx, s.actor, b2b.id));
  let inv = await db.invoice.findUniqueOrThrow({ where: { id: b2b.id } });
  assert.equal(inv.zki, null);
  assert.equal(inv.fiscalStatus, 'PENDING');
  const o = await afterIssue(b2b.id, s.actor);
  assert.ok(o?.ok, o?.message);
  inv = await db.invoice.findUniqueOrThrow({ where: { id: b2b.id } });
  assert.equal(inv.fiscalStatus, 'SENT');
  assert.match(String((inv.eInvoice as { id?: string }).id), /^DEMO-/);

  const b2c = await draft(s, s.citizen.id, 'TRANSFER');
  await transaction((tx) => issueInvoice(tx, s.actor, b2c.id));
  inv = await db.invoice.findUniqueOrThrow({ where: { id: b2c.id } });
  assert.match(inv.zki ?? '', /^[0-9a-f]{32}$/);
  // naknadna dostava pokupi sve što čeka
  const r = await retryPending(s.actor);
  assert.equal(r.ok, 1);
  assert.equal(r.remaining, 0);
});

test('bez OIB-a operatera račun za gotovinu se ne izdaje; isključena fiskalizacija ne smeta', async () => {
  const s = await setup({ operatorOib: null });
  const d = await draft(s, s.citizen.id, 'CARD');
  await assert.rejects(transaction((tx) => issueInvoice(tx, s.actor, d.id)), /OIB operatera/);
  const still = await db.invoice.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(still.status, 'DRAFT');
  await db.company.update({ where: { id: s.companyId }, data: { fiscalEnabled: false } });
  await transaction((tx) => issueInvoice(tx, s.actor, d.id));
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(inv.fiscalStatus, 'NOT_REQUIRED');
  assert.equal(inv.zki, null);
});

test('zauzimanje: istodobni pozivi šalju račun u CIS samo jednom, JIR se ne prepisuje', async () => {
  const s = await setup();
  const d = await draft(s, s.citizen.id, 'CASH');
  await transaction((tx) => issueInvoice(tx, s.actor, d.id));
  // afterIssue, „Ponovi fiskalizaciju" i naknadna dostava u isto vrijeme
  const outs = await Promise.all([afterIssue(d.id, s.actor), fiscalizeInvoice(d.id, s.actor), fiscalizeInvoice(d.id, s.actor), retryPending(s.actor)]);
  const sent = outs.slice(0, 3).filter((o) => o && o.ok && !o.skipped);
  const byRetry = (outs[3] as Awaited<ReturnType<typeof retryPending>>).ok;
  assert.equal(sent.length + byRetry, 1, 'točno jedan poziv šalje');
  const logs = await db.fiscalLog.findMany({ where: { invoiceId: d.id, kind: 'FISCAL' } });
  assert.equal(logs.filter((l) => l.ok).length, 1);
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(inv.fiscalStatus, 'SENT');
  assert.equal(inv.fiscalAttempts, 1);
  assert.ok(!('sending' in (inv.eInvoice as object)), 'oznaka zauzimanja je uklonjena');
  // već fiskaliziran → ne šalje se i JIR ostaje isti
  const again = await fiscalizeInvoice(d.id, s.actor);
  assert.ok(again.skipped);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: d.id } })).jir, inv.jir);
});

test('zauzimanje: dok traje slanje drugi poziv čeka; napušteno zauzimanje zastari', async () => {
  const s = await setup();
  const d = await draft(s, s.citizen.id, 'CARD');
  await transaction((tx) => issueInvoice(tx, s.actor, d.id));
  const t0 = new Date();
  const first = await claimSend(d.id, s.companyId, 'cis', t0);
  assert.ok(first);
  assert.equal(await claimSend(d.id, s.companyId, 'cis', t0), null);
  // drugi poziv dok je račun zauzet ne šalje ništa
  const busy = await fiscalizeInvoice(d.id, s.actor);
  assert.equal(busy.ok, false);
  assert.ok(busy.skipped);
  assert.match(busy.message, /upravo šalje/);
  assert.equal(await db.fiscalLog.count({ where: { invoiceId: d.id } }), 0);
  // proces je pao usred slanja: nakon CLAIM_STALE_MS račun se može ponovno zauzeti
  const later = await claimSend(d.id, s.companyId, 'cis', new Date(t0.getTime() + CLAIM_STALE_MS + 1000));
  assert.ok(later);
  assert.notEqual(later.token, first.token);
  // druga firma ne može zauzeti tuđi račun
  const other = await setup();
  assert.equal(await claimSend(d.id, other.companyId, 'cis', new Date(t0.getTime() + 2 * CLAIM_STALE_MS)), null);
});

test('zauzimanje eRačuna: istodobno slanje daje jedan dokument kod posrednika', async () => {
  const s = await setup();
  const d = await draft(s, s.business.id, 'TRANSFER');
  await transaction((tx) => issueInvoice(tx, s.actor, d.id));
  const outs = await Promise.all([sendEInvoice(d.id, s.actor), sendEInvoice(d.id, s.actor), afterIssue(d.id, s.actor)]);
  assert.equal(outs.filter((o) => o && o.ok && !o.skipped).length, 1);
  const logs = await db.fiscalLog.findMany({ where: { invoiceId: d.id, kind: 'EINVOICE', ok: true } });
  assert.equal(logs.length, 1);
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(inv.fiscalStatus, 'SENT');
  assert.match(String((inv.eInvoice as { id?: string }).id), /^DEMO-/);
  // ponovno slanje ne stvara drugi dokument
  const again = await sendEInvoice(d.id, s.actor);
  assert.ok(again.skipped);
});

test('naknadna dostava: vremensko ograničenje prekida dostavu', async () => {
  const s = await setup();
  const d = await draft(s, s.citizen.id, 'CASH');
  await transaction((tx) => issueInvoice(tx, s.actor, d.id));
  const r = await retryPending(s.actor, 50, -1);
  assert.equal(r.ok, 0);
  assert.match(r.stopped ?? '', /prekinuto/);
  assert.equal(r.remaining, 1);
});
