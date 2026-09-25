/**
 * Prodaja — ispravci nakon pregleda koda (testna baza): razdoblje računa za najam
 * (bez dvostruke naplate), jednokratni ugovor, istodobno slanje i prijava eRačuna,
 * porezni tretman najma stranom kupcu i prijava naplate za tip I.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { addPayment, createDraft, issueInvoice, type InvoiceInput } from '../../src/server/services/invoices';
import { coveredPeriods } from '../../src/server/services/contract-items';
import { checkInvoiceContract, openInvoiceContract } from '../../src/server/services/invoice-rent';
import { reportLatestPayment } from '../../src/server/fiscal';
import { claimSend, releaseClaim } from '../../src/server/fiscal/claim';
import { reportWithoutSending, resetEInvoiceTrace } from '../../src/server/fiscal/einvoice-ops';
import { invoiceUbl } from '../../src/server/fiscal/ubl-source';
import { addMonths, fromISO, today } from '../../src/domain/dates';
import { EXEMPT_DEFAULTS } from '../../src/domain/tax';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');
process.env.AUTH_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';

const companies: string[] = [];
const OIB = '12345678903';

async function setup(opts: { einvoice?: boolean } = {}) {
  const c = await db.company.create({
    data: {
      name: `AR ${Date.now()}-${Math.random()}`,
      oib: OIB,
      iban: 'HR1210010051863000160',
      invoicePremises: 'A1',
      kpdSale: '26.20.11',
      kpdRent: '77.33.01',
      kpdService: '62.90.10',
      ...(opts.einvoice ? { fiscalEnabled: true, fiscalEnv: 'TEST', eInvoiceProvider: 'demo', paymentModel: 'HR01', eInvoicePaymentMeans: '58' } : {}),
    },
  });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `ar${Date.now()}${Math.random()}@t.hr`, name: 'Prodavač', passwordHash: 'x', role: 'ADMIN', oib: OIB } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20 } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530' } });
  const foreign = await db.partner.create({ data: { companyId: c.id, name: 'Kunde GmbH', country: 'DE', vatId: 'DE123456789' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const items = [];
  for (let i = 0; i < 5; i++) {
    items.push(
      await db.item.create({
        data: { companyId: c.id, serial: `AR-SN${i}`, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2026-01-01') },
      }),
    );
  }
  return { companyId: c.id, actor, model, partner, foreign, items };
}

type S = Awaited<ReturnType<typeof setup>>;

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

const inv = (s: S, over: Partial<InvoiceInput>): InvoiceInput => ({ type: 'RENT', partnerId: s.partner.id, date: today(), vatRate: 25, lines: [], ...over });
const rentLine = (itemId: string, months = 1) => ({ kind: 'DEVICE' as const, itemId, description: 'Najam Sunmi T2s', qty: 1, unitPrice: 50 * months, monthly: 50, months });
const issueNew = async (s: S, over: Partial<InvoiceInput>) => {
  const id = await transaction(async (tx) => {
    const d = await createDraft(tx, s.actor, inv(s, over));
    await issueInvoice(tx, s.actor, d.id);
    return d.id;
  });
  return db.invoice.findUniqueOrThrow({ where: { id } });
};

test('račun za najam: već fakturirano razdoblje i uređaji na različitim ratama se odbijaju (bez dvostruke naplate)', async () => {
  const s = await setup();
  const [a, b] = s.items;
  const month = today().slice(0, 7);
  const c = await transaction((tx) => openInvoiceContract(tx, s.actor, s.partner.id, { startDate: today(), billing: 'MONTHLY', months: 24, seasonFrom: null, seasonTo: null }));
  const first = await issueNew(s, { contractId: c.id, lines: [rentLine(a.id)] });
  assert.equal(first.period, month);

  // isto razdoblje za isti uređaj, ručno odabrano → odbijeno
  await assert.rejects(issueNew(s, { contractId: c.id, period: month, lines: [rentLine(a.id)] }), /već fakturiran/);
  // bez odabira: najranija nefakturirana rata uređaja s računa — ovdje B (novi, ovaj mjesec), a A je već
  // fakturiran za ovaj mjesec → jedan račun ne može pokriti oba
  await assert.rejects(issueNew(s, { contractId: c.id, lines: [rentLine(a.id), rentLine(b.id)] }), /AR-SN0 — .* već fakturiran.*zasebnim računima/);
  // broj mjeseci na stavci mora odgovarati rati (mjesečna rata, stavka 3 mj.)
  await assert.rejects(issueNew(s, { contractId: c.id, lines: [rentLine(a.id, 3)] }), /pokriva 1 mj\., a stavka 3 mj\./);
  // ispravno: sljedeća rata uređaja A
  const second = await issueNew(s, { contractId: c.id, lines: [rentLine(a.id)] });
  assert.equal(second.period, addMonths(`${month}-01`, 1).slice(0, 7));
  const cov = (await coveredPeriods(db, [c.id])).get(c.id)!;
  assert.ok(cov.has(`${a.id}|${month}`) && cov.has(`${a.id}|${second.period}`));
  assert.equal([...cov].filter((k) => k.startsWith(`${a.id}|`)).length, 2, 'svako razdoblje fakturirano jednom');
});

test('račun za najam: jednokratni ugovor se ne nudi i ne prima nove uređaje s računa', async () => {
  const s = await setup();
  const once = await db.contract.create({
    data: { companyId: s.companyId, number: `UG-ONCE-${Date.now()}`, partnerId: s.partner.id, startDate: fromISO(today()), endDate: fromISO(addMonths(today(), 12)), billing: 'ONCE' },
  });
  await assert.rejects(transaction((tx) => checkInvoiceContract(tx, s.actor, once.id, s.partner.id)), /jednokratnu naplatu/);
  // nacrt s takvim ugovorom (npr. od prije) ne izdaje se — uređaj bi dobio mjesečnu naplatu
  await assert.rejects(issueNew(s, { contractId: once.id, lines: [rentLine(s.items[0].id)] }), /jednokratnu naplatu/);
  assert.equal(await db.contractItem.count({ where: { contractId: once.id } }), 0);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: s.items[0].id } })).state, 'IN_STOCK');
});

test('najam kupcu u EU: AE i čl. 17. (usluga), ne čl. 41.; miješani račun stranom kupcu se odbija', async () => {
  const s = await setup();
  const c = await transaction((tx) => openInvoiceContract(tx, s.actor, s.foreign.id, { startDate: today(), billing: 'MONTHLY', months: 12, seasonFrom: null, seasonTo: null }));
  // ulaz kakav je slao stari editor / rata iz Najma: tretman robe
  const goods = { vatRate: 0, taxCategory: 'K', taxExemptReason: 'Oslobođeno PDV-a — isporuka unutar EU (čl. 41. Zakona o PDV-u)' };
  const rent = await issueNew(s, { partnerId: s.foreign.id, contractId: c.id, ...goods, lines: [rentLine(s.items[0].id)] });
  assert.equal(rent.taxCategory, 'AE');
  assert.equal(rent.taxExemptReason, EXEMPT_DEFAULTS.euService);
  const ubl = await invoiceUbl(s.companyId, rent.id);
  assert.match(ubl!.xml!, /<cbc:ID>AE<\/cbc:ID>/);
  assert.match(ubl!.xml!, /čl\. 17\. st\. 1\./);
  assert.doesNotMatch(ubl!.xml!, /čl\. 41/);

  // vlastiti tekst firme za uslugu u EU
  await db.company.update({ where: { id: s.companyId }, data: { vatTextEuService: 'Reverse charge (čl. 17. st. 1. ZPDV)' } });
  const svc = await transaction((tx) =>
    createDraft(tx, s.actor, inv(s, { type: 'SERVICE', partnerId: s.foreign.id, ...goods, lines: [{ kind: 'MANUAL', description: 'Servis', qty: 1, unitPrice: 80 }] })),
  );
  const svcRow = await db.invoice.findUniqueOrThrow({ where: { id: svc.id } });
  assert.deepEqual([svcRow.taxCategory, svcRow.taxExemptReason], ['AE', 'Reverse charge (čl. 17. st. 1. ZPDV)']);

  // prodaja robe ostaje K / čl. 41.
  const sale = await transaction((tx) =>
    createDraft(tx, s.actor, inv(s, { type: 'SALE', partnerId: s.foreign.id, ...goods, lines: [{ kind: 'DEVICE', itemId: s.items[1].id, description: 'Sunmi T2s', qty: 1, unitPrice: 300 }] })),
  );
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: sale.id } })).taxCategory, 'K');

  // roba + najam stranom kupcu na istom računu → jasna poruka
  await assert.rejects(
    transaction((tx) =>
      createDraft(
        tx,
        s.actor,
        inv(s, {
          type: 'SALE',
          partnerId: s.foreign.id,
          contractId: c.id,
          ...goods,
          lines: [
            { kind: 'DEVICE', itemId: s.items[2].id, description: 'Sunmi T2s', qty: 1, unitPrice: 300 },
            { ...rentLine(s.items[3].id), lineType: 'RENT' as const },
          ],
        }),
      ),
    ),
    /zasebnim računima/,
  );
});

test('eRačun: prijava bez slanja i poništenje traga poštuju slanje u tijeku; naplata za tip I se ne prijavljuje', async () => {
  const s = await setup({ einvoice: true });
  const mk = (partnerId: string) =>
    transaction(async (tx) => {
      const d = await createDraft(tx, s.actor, inv(s, { type: 'SERVICE', partnerId, taxCategory: 'S', paymentMethod: 'TRANSFER', lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 100 }] }));
      await issueInvoice(tx, s.actor, d.id);
      return d;
    });

  // slanje u tijeku (oznaka zauzimanja) → IR ne prolazi i ne prepisuje stanje
  const a = await mk(s.partner.id);
  const claim = await claimSend(a.id, s.companyId, 'einvoice');
  assert.ok(claim);
  const busy = await reportWithoutSending(a.id, s.actor, 'IR');
  assert.equal(busy.ok, false);
  assert.match(busy.message, /upravo šalje/);
  let row = await db.invoice.findUniqueOrThrow({ where: { id: a.id } });
  assert.notEqual(row.fiscalStatus, 'SENT');
  assert.equal((row.eInvoice as { id?: string }).id, undefined);
  await releaseClaim(a.id, claim.token, claim.meta);
  const ir = await reportWithoutSending(a.id, s.actor, 'IR');
  assert.ok(ir.ok, ir.message);
  row = await db.invoice.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(row.fiscalStatus, 'SENT');
  assert.equal((row.eInvoice as { sending?: unknown }).sending, undefined, 'oznaka zauzimanja je obrisana');
  // već poslan/prijavljen: druga prijava ne prolazi
  assert.equal((await reportWithoutSending(a.id, s.actor, 'IR')).ok, false);

  // poništenje traga dok slanje (npr. CIS) drži oznaku → odbijeno; nakon otpuštanja prolazi
  const cis = await claimSend(a.id, s.companyId, 'cis');
  assert.ok(cis);
  const r1 = await resetEInvoiceTrace(a.id, s.actor);
  assert.equal(r1.ok, false);
  assert.match(r1.message, /upravo šalje/);
  assert.ok((await db.invoice.findUniqueOrThrow({ where: { id: a.id }, select: { eInvoice: true } })).eInvoice);
  await releaseClaim(a.id, cis.token, cis.meta);
  const r2 = await resetEInvoiceTrace(a.id, s.actor);
  assert.ok(r2.ok, r2.message);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: a.id } })).eInvoiceStatus, null);

  // tip I (strani kupac): uplata se ne prijavljuje posredniku kao naplata eRačuna
  const f = await mk(s.foreign.id);
  assert.ok((await reportWithoutSending(f.id, s.actor, 'I')).ok);
  await transaction((tx) => addPayment(tx, s.actor, f.id, { date: today(), amount: 50, method: 'Virman', note: null }));
  assert.equal(await reportLatestPayment(f.id, s.actor), null);
  assert.equal(await db.fiscalLog.count({ where: { invoiceId: f.id, kind: 'PAYMENT_REPORT' } }), 0);
});
