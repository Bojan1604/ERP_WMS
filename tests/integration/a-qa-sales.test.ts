/**
 * QA prodaja (t1) — testna baza: datum računa u budućnosti, dospijeće, KPD za eRačun,
 * preslika postavki firme na izdanom računu, uračunati predujmovi (BillingReference,
 * zaštita od dvostrukog uračunavanja, marže bez predujma), preplata i povrat kupcu,
 * cijene za novog kupca, pretraga uređaja po marki i modelu, poništenje traga eRačuna
 * i zadani operater firme.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { addPayment, createDraft, creditNote, issueInvoice, refundPayment, stornoInvoice, updateDraft, type InvoiceInput } from '../../src/server/services/invoices';
import { partnerAdvanceOptions } from '../../src/server/services/invoice-advances';
import { invoiceUbl } from '../../src/server/fiscal/ubl-source';
import { resetEInvoiceTrace } from '../../src/server/fiscal/einvoice-ops';
import { sendEInvoice } from '../../src/server/fiscal';
import { linePrices, listInvoices, readInvoiceFilters, searchDevices } from '../../src/server/queries/sales';
import { business, readMarginFilters } from '../../src/server/queries/margins';
import { addDays, fromISO, today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');
process.env.AUTH_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';

const companies: string[] = [];
const OIB = '12345678903';

async function setup(opts: { einvoice?: boolean; kpd?: boolean; userOib?: string | null } = {}) {
  const c = await db.company.create({
    data: {
      name: `AQ ${Date.now()}-${Math.random()}`,
      oib: OIB,
      iban: 'HR1210010051863000160',
      invoicePremises: 'A1',
      ...(opts.kpd === false ? {} : { kpdSale: '26.20.11', kpdRent: '77.33.01', kpdService: '62.90.10' }),
      ...(opts.einvoice ? { fiscalEnabled: true, fiscalEnv: 'TEST', eInvoiceProvider: 'demo' } : {}),
    },
  });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({
    data: { companyId: c.id, email: `aq${Date.now()}${Math.random()}@t.hr`, name: 'Prodavač', passwordHash: 'x', role: 'ADMIN', oib: opts.userOib === undefined ? OIB : opts.userOib },
  });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Epson', name: 'TM-m30III', salePrice: 300, rentPrice: 20, kpd: '26.20.16' } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530', address: 'Riva 2', zip: '21000', city: 'Split' } });
  const other = await db.partner.create({ data: { companyId: c.id, name: 'Drugi d.o.o.', oib: '94577403194' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const items = [];
  for (let i = 0; i < 4; i++) {
    items.push(
      await db.item.create({
        data: { companyId: c.id, serial: `AQ-SN${i}-${Math.random()}`, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 100 + i * 10, importDate: fromISO('2026-01-01') },
      }),
    );
  }
  return { companyId: c.id, actor, model, partner, other, items };
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

const service = (over: Partial<InvoiceInput> = {}) => (s: S): InvoiceInput => ({
  type: 'SERVICE',
  partnerId: s.partner.id,
  date: today(),
  vatRate: 25,
  lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 100 }],
  ...over,
});
const draft = (s: S, input: InvoiceInput) => transaction((tx) => createDraft(tx, s.actor, input));
const issue = (s: S, id: string) => transaction((tx) => issueInvoice(tx, s.actor, id));
const issueNew = async (s: S, input: InvoiceInput) => {
  const d = await draft(s, input);
  await issue(s, d.id);
  return db.invoice.findUniqueOrThrow({ where: { id: d.id } });
};

test('datum u budućnosti: nacrt da, izdavanje / storno / odobrenje ne; dospijeće prije datuma se odbija', async () => {
  const s = await setup();
  const future = addDays(today(), 7);
  const d = await draft(s, service({ date: future })(s));
  await assert.rejects(issue(s, d.id), /je u budućnosti/);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: d.id } })).status, 'DRAFT');
  // predujam ide istim putem
  const adv = await draft(s, service({ kind: 'ADVANCE', date: future })(s));
  await assert.rejects(issue(s, adv.id), /je u budućnosti/);

  const inv = await issueNew(s, service()(s));
  await assert.rejects(transaction((tx) => stornoInvoice(tx, s.actor, inv.id, { date: future })), /je u budućnosti/);
  await assert.rejects(transaction((tx) => creditNote(tx, s.actor, inv.id, { date: future, description: 'X', netAmount: 10 })), /je u budućnosti/);
  // današnji račun i dalje prolazi (numeracija nije zaključana)
  assert.ok((await issueNew(s, service()(s))).number);

  await assert.rejects(draft(s, service({ dueDate: addDays(today(), -1) })(s)), /Dospijeće .* ne može biti prije datuma računa/);
  const d2 = await draft(s, service()(s));
  await assert.rejects(transaction((tx) => updateDraft(tx, s.actor, d2.id, service({ dueDate: addDays(today(), -3) })(s))), /ne može biti prije datuma/);
});

test('poruka o redoslijedu datuma navodi zadnji izdani dokument', async () => {
  const s = await setup();
  const a = await issueNew(s, service()(s));
  await transaction((tx) => stornoInvoice(tx, s.actor, a.id));
  const d = await draft(s, service({ date: addDays(today(), -5) })(s));
  await assert.rejects(issue(s, d.id), /Zadnji izdani dokument \(storno računa .*\) ima datum/);
});

test('KPD: neispravan oblik se odbija; eRačun bez KPD-a se ne izdaje; najam ne uzima KPD robe; odobrenje kopira KPD', async () => {
  const s = await setup({ einvoice: true, kpd: false });
  await assert.rejects(draft(s, service({ lines: [{ kind: 'MANUAL', description: 'X', kpd: '99.9', qty: 1, unitPrice: 1 }] })(s)), /Stavka 1: KPD „99\.9" nije oblika NN\.NN\.NN/);
  await assert.rejects(draft(s, service({ lines: [{ kind: 'MANUAL', description: 'X', kpd: 'ab.cd.ef', qty: 1, unitPrice: 1 }] })(s)), /nije oblika/);

  // domaći poslovni kupac + posrednik → eRačun: ručna stavka bez KPD-a blokira izdavanje (poruka po stavci)
  const d = await draft(s, service({ lines: [{ kind: 'MANUAL', description: 'Montaža', qty: 1, unitPrice: 50 }, { kind: 'MANUAL', description: 'Kabel', kpd: '27.32.13', qty: 1, unitPrice: 5 }] })(s));
  await assert.rejects(issue(s, d.id), /Stavka 1 \(Montaža\) nema KPD 2025 šifru/);

  // najam bez KPD-a za najam (model ni firma): ne uzima KPD robe s modela
  const rent = await draft(s, { type: 'RENT', partnerId: s.partner.id, date: today(), vatRate: 25, lines: [{ kind: 'MODEL', modelId: s.model.id, description: 'Najam Epson', qty: 1, unitPrice: 60, monthly: 20, months: 3 }] });
  const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: rent.id } });
  assert.equal(line.kpd, null);

  // odobrenje: KPD izvornih stavki (sve iste) ide na stavku odobrenja
  const ok = await issueNew(s, service({ lines: [{ kind: 'MANUAL', description: 'Servis', kpd: '95.11.10', qty: 1, unitPrice: 100 }] })(s));
  const cn = await transaction((tx) => creditNote(tx, s.actor, ok.id, { description: 'Popust', netAmount: 10 }));
  assert.equal((await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: cn.id } })).kpd, '95.11.10');

  // stariji izdani račun bez KPD-a: lokalna provjera prije slanja posredniku
  const legacy = await issueNew(s, service({ lines: [{ kind: 'MANUAL', description: 'Stari', kpd: '62.90.10', qty: 1, unitPrice: 10 }] })(s));
  await db.invoiceLine.updateMany({ where: { invoiceId: legacy.id }, data: { kpd: null } });
  const r = await sendEInvoice(legacy.id, s.actor);
  assert.equal(r.ok, false);
  assert.match(r.message, /Stavka 1 \(Stari\) nema KPD 2025 šifru/);
  assert.equal(await db.fiscalLog.count({ where: { invoiceId: legacy.id } }), 0, 'ništa nije poslano posredniku');
});

test('izdani račun pamti postavke firme (PDV po naplati, sustav PDV-a) — kasnija promjena ga ne mijenja', async () => {
  const s = await setup();
  const inv = await issueNew(s, service()(s));
  assert.equal(inv.vatOnPayment, false);
  assert.equal(inv.sellerVatRegistered, true);
  await db.company.update({ where: { id: s.companyId }, data: { vatOnPayment: true, vatRegistered: false } });
  const u = await invoiceUbl(s.companyId, inv.id);
  assert.ok(u?.xml);
  assert.doesNotMatch(u.xml, /HRObracunPDVPoNaplati/);
  assert.doesNotMatch(u.xml, /<cbc:ID>FRE<\/cbc:ID>/);
  assert.match(u.xml, /<cbc:ID>S<\/cbc:ID>/);
  // novi račun nakon promjene nosi nove postavke
  const next = await issueNew(s, service()(s));
  assert.equal(next.vatOnPayment, true);
  assert.equal(next.sellerVatRegistered, false);
  assert.match((await invoiceUbl(s.companyId, next.id))!.xml!, /HRObracunPDVPoNaplati/);
});

test('predujam: odabir računa za predujam, ostatak, BillingReference, bez dvostrukog uračunavanja; marže bez predujma', async () => {
  const s = await setup();
  const adv = await issueNew(s, service({ kind: 'ADVANCE', lines: [{ kind: 'MANUAL', description: 'Predujam', qty: 1, unitPrice: 100 }] })(s));
  assert.equal(adv.grandTotal.toNumber(), 125);

  let opts = await partnerAdvanceOptions(db, s.companyId, s.partner.id);
  assert.deepEqual(opts.map((o) => [o.id, o.remaining]), [[adv.id, 125]]);
  assert.equal((await partnerAdvanceOptions(db, s.companyId, s.other.id)).length, 0);

  const fin = await issueNew(s, service({ advances: [{ advanceId: adv.id, amount: 100 }], lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 200 }] })(s));
  assert.equal(fin.advanceAmount.toNumber(), 100);
  assert.equal(fin.openAmount.toNumber(), 150); // 250 − 100
  const ubl = await invoiceUbl(s.companyId, fin.id);
  assert.match(ubl!.xml!, new RegExp(`<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${adv.number!.replace(/\//g, '\\/')}</cbc:ID>`));
  assert.match(ubl!.xml!, /<cbc:ProfileID>P11<\/cbc:ProfileID>/);
  assert.match(ubl!.xml!, /<cbc:PrepaidAmount currencyID="EUR">100\.00<\/cbc:PrepaidAmount>/);

  opts = await partnerAdvanceOptions(db, s.companyId, s.partner.id);
  assert.equal(opts[0].remaining, 25);
  // isti predujam iznad ostatka se ne može uračunati ni u nacrt ni pri izdavanju
  await assert.rejects(draft(s, service({ advances: [{ advanceId: adv.id, amount: 50 }] })(s)), /preostalo za uračunati je 25,00 €/);
  // dva nacrta s ostatkom: drugi pri izdavanju više nema ostatka
  const d1 = await draft(s, service({ advances: [{ advanceId: adv.id, amount: 25 }] })(s));
  const d2 = await draft(s, service({ advances: [{ advanceId: adv.id, amount: 25 }] })(s));
  await issue(s, d1.id);
  await assert.rejects(issue(s, d2.id), /preostalo za uračunati je 0,00 €/);
  // tuđi kupac i predujam kao konačni račun
  await assert.rejects(draft(s, service({ partnerId: s.other.id, advances: [{ advanceId: adv.id, amount: 1 }] })(s)), /izdan drugom kupcu/);
  await assert.rejects(draft(s, service({ kind: 'ADVANCE', advances: [{ advanceId: adv.id, amount: 1 }] })(s)), /samo na konačni račun/);

  // uračunati predujam se ne stornira; nakon storna konačnog računa ostatak se vraća
  await assert.rejects(transaction((tx) => stornoInvoice(tx, s.actor, adv.id)), /uračunat u račun/);
  await transaction((tx) => stornoInvoice(tx, s.actor, fin.id));
  opts = await partnerAdvanceOptions(db, s.companyId, s.partner.id);
  assert.equal(opts[0].remaining, 100);

  // marže (Poslovanje): prihod bez računa za predujam — osnovica konačnih računa (storno umanjuje)
  const b = await business(s.companyId, readMarginFilters({}));
  // računi: 100 (usluga d1, 100 neto) + 200 − 200 (konačni i storno); predujam (100) se ne broji
  assert.equal(b.revenue, 100);
});

test('odobrenje na plaćeni račun: iznos za povrat kupcu i evidencija povrata', async () => {
  const s = await setup();
  const inv = await issueNew(s, service()(s));
  await transaction((tx) => addPayment(tx, s.actor, inv.id, { date: today(), amount: 125 }));
  await transaction((tx) => creditNote(tx, s.actor, inv.id, { description: 'Popust', netAmount: 20 }));
  let row = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.equal(row.openAmount.toNumber(), 0);
  assert.equal(row.creditedTotal.toNumber(), 25);
  await assert.rejects(transaction((tx) => refundPayment(tx, s.actor, inv.id, { date: today(), amount: 30 })), /Povrat je veći od preplate \(25,00 €\)/);
  await transaction((tx) => refundPayment(tx, s.actor, inv.id, { date: today(), amount: 25 }));
  row = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.equal(row.paidTotal.toNumber(), 100);
  await assert.rejects(transaction((tx) => refundPayment(tx, s.actor, inv.id, { date: today(), amount: 1 })), /nema preplate/);
  // poruka preplate uplate je u eurima
  const other = await issueNew(s, service()(s));
  await assert.rejects(transaction((tx) => addPayment(tx, s.actor, other.id, { date: today(), amount: 1026 })), /Uplata je veća od otvorenog iznosa \(125,00 €\)/);
});

test('popis računa: neispravan datum u filtru ne ruši upit; cijene za novog kupca; pretraga marka + model', async () => {
  const s = await setup();
  const f = readInvoiceFilters({ do: '2026-13-45', od: '2026-02-30' });
  assert.equal(f.to, '');
  assert.equal(f.from, '');
  await listInvoices(s.companyId, f, { skip: 0, take: 10 });

  await db.priceAgreement.create({ data: { companyId: s.companyId, partnerId: s.partner.id, modelId: s.model.id, salePrice: 250, rentPrice: 15 } });
  const lines = [
    { key: 'a', itemId: s.items[0].id, lineType: 'SALE' as const },
    { key: 'b', itemId: s.items[1].id, lineType: 'RENT' as const },
  ];
  assert.deepEqual(await linePrices(s.companyId, s.partner.id, lines), { a: { price: 250, agreed: true }, b: { price: 15, agreed: true } });
  // drugi kupac bez dogovora: cijena modela, bez oznake cjenika
  assert.deepEqual(await linePrices(s.companyId, s.other.id, lines), { a: { price: 300, agreed: false }, b: { price: 20, agreed: false } });

  const found = await searchDevices(s.companyId, { q: 'Epson TM-m30III' });
  assert.equal(found.length, 4);
  assert.equal((await searchDevices(s.companyId, { q: 'epson m30' })).length, 4);
  assert.equal((await searchDevices(s.companyId, { q: 'Epson Sunmi' })).length, 0);
});

test('poništenje traga eRačuna vraća brojač pokušaja; zadani operater firme kad korisnik nema OIB', async () => {
  const s = await setup({ einvoice: true, userOib: null });
  await db.company.update({ where: { id: s.companyId }, data: { operatorName: 'Ana Operater', operatorOib: '94577403194' } });
  const inv = await issueNew(s, service({ lines: [{ kind: 'MANUAL', description: 'Servis', kpd: '95.11.10', qty: 1, unitPrice: 10 }] })(s));
  const meta = inv.eInvoice as { operator?: { name: string; oib: string | null } };
  assert.deepEqual(meta.operator, { name: 'Ana Operater', oib: '94577403194' });
  const sent = await sendEInvoice(inv.id, s.actor);
  assert.ok(sent.ok, sent.message);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).fiscalAttempts, 1);
  const r = await resetEInvoiceTrace(inv.id, s.actor);
  assert.ok(r.ok, r.message);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).fiscalAttempts, 0);
});
