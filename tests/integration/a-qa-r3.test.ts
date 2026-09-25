/**
 * QA prodaja, krug 3 (t1): e-pošta storniranog računa (C) i kompaktni PDF računa (D):
 * 14 stavki s plaćanjem i 2D barkodom na jednoj stranici, KPD samo sa stavke.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { Actor } from '../../src/server/services/items';
import { createDraft, issueInvoice, stornoInvoice, type InvoiceInput } from '../../src/server/services/invoices';
import { resolveDoc } from '../../src/server/mail/draft';
import { documentDefinitionFor, renderDocumentPdf } from '../../src/server/pdf';
import { today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');
process.env.AUTH_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';

const companies: string[] = [];

async function setup() {
  const c = await db.company.create({
    data: {
      name: `AR3 ${Date.now()}-${Math.random()}`,
      oib: '12345678903',
      iban: 'HR1210010051863000160',
      address: 'Radnička cesta 80',
      zip: '10000',
      city: 'Zagreb',
      email: 'info@firma.hr',
      phone: '+385 1 555 0101',
      web: 'www.firma.hr',
      legalFooter: 'Društvo je upisano u sudski registar Trgovačkog suda u Zagrebu. Temeljni kapital 2.654,46 € uplaćen u cijelosti.',
      invoicePremises: 'A1',
      kpdSale: '26.20.11',
      kpdRent: '77.33.01',
      kpdService: '62.90.10',
    },
  });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `ar3${Date.now()}${Math.random()}@t.hr`, name: 'Prodavač', passwordHash: 'x', role: 'ADMIN', oib: '12345678903' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530', email: 'kupac@t.hr', address: 'Trg bana Jelačića 4', zip: '10000', city: 'Zagreb' } });
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

const issueNew = async (s: S, input: Partial<InvoiceInput>) => {
  const d = await transaction((tx) =>
    createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: today(), vatRate: 25, paymentMethod: 'TRANSFER', lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 100 }], ...input }),
  );
  await transaction((tx) => issueInvoice(tx, s.actor, d.id));
  return db.invoice.findUniqueOrThrow({ where: { id: d.id } });
};
const pages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

test('C: e-pošta storniranog računa — iznos računa, „storniran" i broj storna', async () => {
  const s = await setup();
  const inv = await issueNew(s, {});
  await transaction((tx) => stornoInvoice(tx, s.actor, inv.id));
  const st = await db.invoice.findFirstOrThrow({ where: { refInvoiceId: inv.id, kind: 'STORNO' } });
  const doc = await resolveDoc(s.user, 'invoice', inv.id);
  assert.equal(doc.template, 'invoiceStornoed');
  assert.equal(doc.vars.iznos, '125,00 €');
  assert.equal(doc.vars.veza, st.number);
});

test('D: PDF računa s 14 stavki (plaćanje, 2D barkod, pravno podnožje) stane na jednu stranicu; KPD samo sa stavke', async () => {
  const s = await setup();
  const lines = Array.from({ length: 14 }, (_, i) => ({ kind: 'MANUAL' as const, description: `Stavka broj ${i + 1} — instalacija i konfiguracija opreme`, kpd: '62.09.20', qty: 1, unitPrice: 11 + i }));
  const inv = await issueNew(s, { lines });
  const pdf = await renderDocumentPdf('invoice', inv.id, s.companyId);
  assert.equal(pages(pdf.buffer), 1);
  // stavka bez KPD-a: na PDF-u prazno (kao stranica računa), ne zadani KPD firme ni modela
  await db.invoiceLine.updateMany({ where: { invoiceId: inv.id, sort: 0 }, data: { kpd: null } });
  const { def } = await documentDefinitionFor('invoice', inv.id, s.companyId);
  const json = JSON.stringify(def.content);
  assert.equal((json.match(/62\.09\.20/g) ?? []).length, 13);
  assert.doesNotMatch(json, /62\.90\.10/);
});
