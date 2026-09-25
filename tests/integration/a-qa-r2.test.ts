/**
 * QA prodaja, krug 2 (t1): uračunati predujam najviše do iznosa računa (N1) i
 * predlošci e-pošte prema vrsti i stanju računa (N3).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { Actor } from '../../src/server/services/items';
import { addPayment, createDraft, creditNote, issueInvoice, stornoInvoice, updateDraft, type InvoiceInput } from '../../src/server/services/invoices';
import { invoiceUbl } from '../../src/server/fiscal/ubl-source';
import { resolveDoc } from '../../src/server/mail/draft';
import { today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');
process.env.AUTH_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';

const companies: string[] = [];

async function setup() {
  const c = await db.company.create({
    data: { name: `AR2 ${Date.now()}-${Math.random()}`, oib: '12345678903', iban: 'HR1210010051863000160', invoicePremises: 'A1', kpdSale: '26.20.11', kpdRent: '77.33.01', kpdService: '62.90.10' },
  });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `ar2${Date.now()}${Math.random()}@t.hr`, name: 'Prodavač', passwordHash: 'x', role: 'ADMIN', oib: '12345678903' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530', email: 'kupac@t.hr' } });
  return { companyId: c.id, actor, partner, user: { companyId: c.id, perms: { sales: 'admin' } } as never };
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

const service = (s: S, over: Partial<InvoiceInput> = {}): InvoiceInput => ({
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

test('N1: uračunati predujam ne smije prijeći iznos računa (spremanje, izmjena, izdavanje); UBL Payable ≥ 0', async () => {
  const s = await setup();
  const adv = await issueNew(s, service(s, { kind: 'ADVANCE', lines: [{ kind: 'MANUAL', description: 'Predujam', qty: 1, unitPrice: 400 }] }));
  assert.equal(adv.grandTotal.toNumber(), 500);

  // račun 125 €, predujam 500 → odbijeno
  await assert.rejects(draft(s, service(s, { advances: [{ advanceId: adv.id, amount: 500 }] })), /Uračunati predujam \(500,00 €\) veći je od iznosa računa \(125,00 €\)/);
  // točno iznos računa prolazi
  const d = await draft(s, service(s, { advances: [{ advanceId: adv.id, amount: 125 }] }));
  // izmjena koja smanji račun ispod uračunatog → odbijeno
  await assert.rejects(
    transaction((tx) => updateDraft(tx, s.actor, d.id, service(s, { lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 50 }], advances: [{ advanceId: adv.id, amount: 125 }] }))),
    /veći je od iznosa računa \(62,50 €\)/,
  );
  // nacrt spremljen prije provjere (stari podaci): izdavanje odbija
  await db.advanceUse.updateMany({ where: { invoiceId: d.id }, data: { amount: 500 } });
  await db.invoice.update({ where: { id: d.id }, data: { advanceAmount: 500 } });
  await assert.rejects(issue(s, d.id), /veći je od iznosa računa/);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: d.id } })).status, 'DRAFT');
  // ispravljen nacrt: za platiti 0, račun plaćen predujmom, bez povrata
  await transaction((tx) => updateDraft(tx, s.actor, d.id, service(s, { advances: [{ advanceId: adv.id, amount: 125 }] })));
  await issue(s, d.id);
  const fin = await db.invoice.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(fin.openAmount.toNumber(), 0);
  assert.equal(fin.advanceAmount.toNumber(), 125);
  const xml = (await invoiceUbl(s.companyId, fin.id))!.xml!;
  assert.match(xml, /<cbc:TaxInclusiveAmount currencyID="EUR">125\.00<\/cbc:TaxInclusiveAmount>/);
  assert.match(xml, /<cbc:PrepaidAmount currencyID="EUR">125\.00<\/cbc:PrepaidAmount>/);
  assert.match(xml, /<cbc:PayableAmount currencyID="EUR">0\.00<\/cbc:PayableAmount>/);
});

test('N3: e-pošta — predložak i iznos prema vrsti i stanju računa', async () => {
  const s = await setup();
  const inv = await issueNew(s, service(s));
  // otvoreni račun: otvoreni iznos
  let doc = await resolveDoc(s.user, 'invoice', inv.id);
  assert.equal(doc.template, 'invoice');
  assert.equal(doc.vars.iznos, '125,00 €');
  // djelomično plaćen: otvoreni iznos, ne ukupni
  await transaction((tx) => addPayment(tx, s.actor, inv.id, { date: today(), amount: 25 }));
  doc = await resolveDoc(s.user, 'invoice', inv.id);
  assert.equal(doc.vars.iznos, '100,00 €');
  // plaćen: predložak „plaćeni račun", iznos računa
  await transaction((tx) => addPayment(tx, s.actor, inv.id, { date: today(), amount: 100 }));
  doc = await resolveDoc(s.user, 'invoice', inv.id);
  assert.equal(doc.template, 'invoicePaid');
  assert.equal(doc.vars.iznos, '125,00 €');

  // odobrenje: vlastiti predložak, iznos bez predznaka, veza na račun
  await transaction((tx) => creditNote(tx, s.actor, inv.id, { description: 'Popust', netAmount: 40 }));
  const cn = await db.invoice.findFirstOrThrow({ where: { refInvoiceId: inv.id, kind: 'CREDIT_NOTE' } });
  doc = await resolveDoc(s.user, 'invoice', cn.id);
  assert.equal(doc.template, 'creditNote');
  assert.equal(doc.vars.iznos, '50,00 €');
  assert.equal(doc.vars.veza, inv.number);
  assert.match(doc.title, /^Knjižno odobrenje /);

  // storno
  const inv2 = await issueNew(s, service(s));
  await transaction((tx) => stornoInvoice(tx, s.actor, inv2.id));
  const st = await db.invoice.findFirstOrThrow({ where: { refInvoiceId: inv2.id, kind: 'STORNO' } });
  doc = await resolveDoc(s.user, 'invoice', st.id);
  assert.equal(doc.template, 'storno');
  assert.equal(doc.vars.iznos, '125,00 €');
  assert.equal(doc.vars.veza, inv2.number);

  // račun za predujam
  const adv = await issueNew(s, service(s, { kind: 'ADVANCE' }));
  doc = await resolveDoc(s.user, 'invoice', adv.id);
  assert.equal(doc.template, 'advance');
  assert.equal(doc.vars.iznos, '125,00 €');
  // opomena i dalje s otvorenim iznosom
  doc = await resolveDoc(s.user, 'invoice', adv.id, true);
  assert.equal(doc.template, 'reminder');
});
