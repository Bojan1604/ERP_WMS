/**
 * Područje A: PDF dokumenata (račun svih vrsta, predračun, ponuda, otpremnica,
 * servisni nalog, narudžbenica, primka, popis uređaja ugovora), slanje
 * e-poštom (nodemailer jsonTransport), EmailLog, PDF u eRačunu i ZIP knjigovođe.
 *   TEST_DATABASE_URL=…/wms_test_a npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import nodemailer from 'nodemailer';

process.env.AUTH_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';

import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { createDraft, issueInvoice, stornoInvoice } from '../../src/server/services/invoices';
import { afterIssue } from '../../src/server/fiscal';
import { invoiceUbl } from '../../src/server/fiscal/ubl-source';
import { documentDefinitionFor, renderDocumentPdf, PdfNotImplementedError } from '../../src/server/pdf';
import { embedPdfInUbl, withInvoicePdf } from '../../src/server/pdf/einvoice';
import { buildEmailDraft, sendDocumentEmailImpl, sendTestEmail } from '../../src/server/mail';
import { setMailTransportFactory } from '../../src/server/mail/transport';
import { saveMailSettings, saveMailTemplates } from '../../src/server/mail/settings';
import { decryptSecret } from '../../src/server/fiscal/crypto';
import { buildAccountantZip } from '../../src/server/queries/accountant-export';
import { DomainError } from '../../src/server/errors';
import { ROLE_DEFAULTS } from '../../src/domain/permissions';
import { MAIL_DEFAULTS } from '../../src/domain/mail';
import type { SessionUser } from '../../src/server/auth';
import type { Actor } from '../../src/server/services/items';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const OIB = '12345678903';
const companies: string[] = [];
// 1×1 PNG
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function setup(tag: string) {
  const c = await db.company.create({
    data: {
      name: `Firma ${tag} ${Date.now()}-${Math.random()}`,
      oib: OIB,
      address: 'Ilica 1',
      zip: '10000',
      city: 'Zagreb',
      iban: 'HR1210010051863000160',
      swift: 'ZABAHR2X',
      email: 'racuni@firma.hr',
      logo: LOGO,
      legalFooter: 'Temeljni kapital 2.654,46 EUR · Trgovački sud u Zagrebu · MBS 080000000',
      proformaTitle: 'Proforma',
      invoicePremises: 'PP1',
      invoiceDevice: '1',
      fiscalEnabled: true,
      fiscalEnv: 'TEST',
      eInvoiceProvider: 'demo',
      accountantEmail: 'knjigovodja@ured.hr',
    },
  });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `a${Date.now()}${Math.random()}@t.hr`, name: 'Ana Admin', passwordHash: 'x', role: 'ADMIN', oib: OIB } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const user: SessionUser = { id: u.id, name: u.name, email: u.email, role: 'ADMIN', companyId: c.id, companyName: c.name, perms: ROLE_DEFAULTS.ADMIN, mdmOrgId: null, mdmOrgName: null };
  const business = await db.partner.create({ data: { companyId: c.id, name: 'Kupac Čćžšđ d.o.o.', oib: '69435151530', email: 'kupac@kupac.hr', address: 'Vukovarska 5', zip: '21000', city: 'Split' } });
  const citizen = await db.partner.create({ data: { companyId: c.id, name: 'Ivo Ivić', email: 'ivo@mail.hr' } });
  return { companyId: c.id, actor, user, business, citizen };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const issue = (s: Setup, partnerId: string, lines = [{ kind: 'MANUAL' as const, description: 'Servis pisača — čćžšđ', qty: 2, unitPrice: 50 }]) =>
  transaction(async (tx) => {
    const d = await createDraft(tx, s.actor, { type: 'SERVICE', partnerId, date: '2026-03-10', vatRate: 25, paymentMethod: 'TRANSFER', lines });
    const r = await issueInvoice(tx, s.actor, d.id);
    return { id: d.id, number: r.number };
  });

/** Svi tekstovi iz pdfmake definicije (sadržaj + podnožje prve stranice). */
function texts(def: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === 'string') out.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      for (const k of ['text', 'stack', 'columns', 'table', 'body', 'content']) if (k in o) walk(o[k]);
    }
  };
  const d = def as { content: unknown; footer?: (p: number, n: number) => unknown };
  walk(d.content);
  if (typeof d.footer === 'function') walk(d.footer(1, 2));
  return out.join('\n');
}

const hasImage = (def: unknown) => JSON.stringify(def).includes('data:image/png;base64,');

function zipEntries(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nlen;
  }
  return out;
}

before(async () => {
  await db.$connect();
});

after(async () => {
  setMailTransportFactory(null);
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    await db.purchaseOrder.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

test('PDF računa: sadržaj, HUB-3, SWIFT, pravno podnožje, storno; tuđa firma i nepoznata vrsta odbijeni', async () => {
  const s = await setup('pdf');
  const other = await setup('tuđa');
  const inv = await issue(s, s.business.id);

  const pdf = await renderDocumentPdf('invoice', inv.id, s.companyId);
  assert.equal(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pdf.buffer.length > 2000);
  assert.match(pdf.fileName, /^Racun-.+\.pdf$/);

  const { def } = await documentDefinitionFor('invoice', inv.id, s.companyId);
  const t = texts(def);
  assert.match(t, /RAČUN/);
  assert.ok(t.includes(inv.number!), 'broj računa');
  assert.match(t, /Kupac Čćžšđ d\.o\.o\./);
  assert.match(t, /Servis pisača — čćžšđ/);
  assert.match(t, /OIB 69435151530/);
  assert.match(t, /SWIFT\/BIC ZABAHR2X/);
  assert.match(t, /IBAN HR1210010051863000160/);
  assert.match(t, /Model i poziv na broj/);
  assert.match(t, /125,00/); // 2 × 50 + 25 % PDV
  assert.match(t, /Trgovački sud u Zagrebu/);
  assert.match(t, /valjan je bez potpisa i pečata/);
  assert.match(t, /Račun izdao: Ana Admin/);
  assert.ok(hasImage(def), 'logo i HUB-3 barkod kao PNG');

  // storno: naslov, poziv na izvorni račun, bez podataka za plaćanje
  const st = await transaction((tx) => stornoInvoice(tx, s.actor, inv.id, { reason: 'Pogreška' }));
  const stId = (st as { id: string }).id;
  const sd = (await documentDefinitionFor('invoice', stId, s.companyId)).def;
  const stt = texts(sd);
  assert.match(stt, /STORNO RAČUNA/);
  assert.match(stt, new RegExp(`Odnosi se na račun br\\.[\\s\\S]*${inv.number!.replace(/[/]/g, '\\/')}`));
  assert.doesNotMatch(stt, /Podaci za plaćanje/i);
  assert.equal((await renderDocumentPdf('invoice', stId, s.companyId)).buffer.subarray(0, 4).toString('latin1'), '%PDF');

  await assert.rejects(renderDocumentPdf('invoice', inv.id, other.companyId), DomainError);
  await assert.rejects(renderDocumentPdf('nepostojeca' as never, inv.id, s.companyId), PdfNotImplementedError);
});

test('PDF fiskaliziranog računa (CIS demo): ZKI, JIR i QR kod', async () => {
  const s = await setup('fisk');
  const inv = await issue(s, s.citizen.id);
  await afterIssue(inv.id, s.actor);
  const row = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.ok(row.zki);
  const { def } = await documentDefinitionFor('invoice', inv.id, s.companyId);
  const t = texts(def);
  assert.match(t, /FISKALIZACIJA/);
  assert.ok(t.includes(row.zki!));
  if (row.jir) assert.ok(t.includes(row.jir));
  // QR + HUB-3 + logo
  assert.ok((JSON.stringify(def).match(/data:image\/png;base64,/g) ?? []).length >= 3);
});

test('PDF predračuna, ponude, otpremnice, servisnog naloga, narudžbenice, primke i popisa uređaja', async () => {
  const s = await setup('docs');
  const q = await db.quote.create({
    data: {
      companyId: s.companyId,
      kind: 'PROFORMA',
      number: 'PRED-2026-0007',
      date: new Date('2026-03-01'),
      validUntil: new Date('2026-03-16'),
      partnerId: s.business.id,
      vatRate: 25,
      netTotal: 200,
      vatTotal: 50,
      grandTotal: 250,
      note: 'Isporuka odmah po uplati.',
      lines: { create: [{ kind: 'MANUAL', description: 'Laptop Đuro', qty: 2, unitPrice: 100, netAmount: 200 }] },
    },
  });
  const pro = (await documentDefinitionFor('proforma', q.id, s.companyId)).def;
  const pt = texts(pro);
  assert.match(pt, /PROFORMA/);
  assert.match(pt, /PRED-2026-0007/);
  assert.match(pt, /HR00 7-2026/);
  assert.match(pt, /250,00/);
  assert.match(pt, /Isporuka odmah po uplati/);
  assert.ok(hasImage(pro));
  const proPdf = await renderDocumentPdf('proforma', q.id, s.companyId);
  assert.equal(proPdf.buffer.subarray(0, 4).toString('latin1'), '%PDF');
  assert.match(proPdf.fileName, /^Predracun-PRED-2026-0007\.pdf$/);

  const offer = await db.quote.create({
    data: { companyId: s.companyId, number: 'PON-2026-0001', date: new Date('2026-03-01'), partnerId: s.business.id, vatRate: 25, lines: { create: [{ kind: 'MANUAL', description: 'Najam kopirke', qty: 1, unitPrice: 40, lineType: 'RENT' }] } },
  });
  const ot = texts((await documentDefinitionFor('quote', offer.id, s.companyId)).def);
  assert.match(ot, /PONUDA/);
  assert.match(ot, /Najam — mjesečni iznos/);
  assert.doesNotMatch(ot, /Podaci za plaćanje/i);
  await assert.rejects(documentDefinitionFor('proforma', offer.id, s.companyId), DomainError);

  const inv = await issue(s, s.business.id);
  const dt = texts((await documentDefinitionFor('delivery', inv.id, s.companyId)).def);
  assert.match(dt, /OTPREMNICA/);
  assert.match(dt, /Robu primio/);

  const so = await db.serviceOrder.create({
    data: { companyId: s.companyId, number: 'RMA-2026-0003', serial: 'SN-XYZ-1', partnerId: s.business.id, status: 'REPAIRED', reportedAt: new Date('2026-03-02'), closedAt: new Date('2026-03-05'), issue: 'Ne pali se', diagnosis: 'Neispravno napajanje', solution: 'Zamijenjeno napajanje' },
  });
  const sv = texts((await documentDefinitionFor('service', so.id, s.companyId)).def);
  assert.match(sv, /SERVISNI NALOG/);
  assert.match(sv, /Ne pali se/);
  assert.doesNotMatch(sv, /Neispravno napajanje/);
  const sd = texts((await documentDefinitionFor('service-delivery', so.id, s.companyId)).def);
  assert.match(sd, /NALOG ZA DOSTAVU/);
  assert.match(sd, /Neispravno napajanje/);
  assert.match(sd, /Uređaj preuzeo \(klijent\)/);

  const model = await db.deviceModel.create({ data: { companyId: s.companyId, name: 'ThinkPad X1', brand: 'Lenovo', code: 'TP-X1' } });
  const po = await db.purchaseOrder.create({
    data: { companyId: s.companyId, number: 'NAR-2026-0001', supplierId: s.business.id, date: new Date('2026-03-01'), total: 300, lines: { create: [{ modelId: model.id, qty: 3, unitCost: 100 }] } },
  });
  const pot = texts((await documentDefinitionFor('order', po.id, s.companyId)).def);
  assert.match(pot, /NARUDŽBENICA/);
  assert.match(pot, /Lenovo ThinkPad X1/);
  assert.match(pot, /300,00/);

  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: s.companyId } });
  const rc = await db.goodsReceipt.create({ data: { companyId: s.companyId, number: 'PRM-2026-0001', date: new Date('2026-03-02'), supplierId: s.business.id, warehouseId: wh.id, total: 123.45 } });
  const withCost = texts((await documentDefinitionFor('receipt', rc.id, s.companyId, { showCost: true })).def);
  const noCost = texts((await documentDefinitionFor('receipt', rc.id, s.companyId)).def);
  assert.match(withCost, /123,45/);
  assert.doesNotMatch(noCost, /123,45/, 'bez prava costs nema nabavnih cijena');

  const contract = await db.contract.create({ data: { companyId: s.companyId, number: 'UG-2026-0009', partnerId: s.business.id, startDate: new Date('2026-01-01') } });
  const ct = texts((await documentDefinitionFor('contract-list', contract.id, s.companyId)).def);
  assert.match(ct, /POPIS UREĐAJA/);
  assert.match(ct, /UG-2026-0009/);
});

test('eRačun: PDF računa ugrađen u UBL uz postavku „prilaži PDF", pri stvarnom slanju', async () => {
  const s = await setup('ubl');
  const inv = await issue(s, s.business.id);
  const ubl = await invoiceUbl(s.companyId, inv.id);
  assert.ok(ubl?.xml);
  const withPdf = await withInvoicePdf(ubl.xml, s.companyId, inv.id, true);
  const i = withPdf.indexOf('<cac:AdditionalDocumentReference>');
  assert.ok(i > 0 && i < withPdf.indexOf('<cac:AccountingSupplierParty>'), 'ispred AccountingSupplierParty');
  const b64 = /<cbc:EmbeddedDocumentBinaryObject mimeCode="application\/pdf" filename="([^"]+)">([^<]+)</.exec(withPdf);
  assert.ok(b64);
  assert.match(b64[1], /^Racun-.+\.pdf$/);
  assert.equal(Buffer.from(b64[2], 'base64').subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(await withInvoicePdf(ubl.xml, s.companyId, inv.id, false), ubl.xml);
  assert.equal(embedPdfInUbl('<Invoice/>', 'x.pdf', Buffer.from('%PDF')), '<Invoice/>');

  // stvarno slanje (demo posrednik) nosi PDF; isključena postavka → bez njega
  const sent = await afterIssue(inv.id, s.actor);
  assert.ok(sent?.ok, sent?.message);
  const log1 = await db.fiscalLog.findFirstOrThrow({ where: { invoiceId: inv.id, kind: 'EINVOICE', ok: true }, orderBy: { at: 'desc' } });
  const bytes1 = Number(/"bytes":(\d+)/.exec(log1.response ?? '')?.[1]);
  assert.ok(bytes1 > ubl.xml.length + 1000, 'poslani XML sadrži PDF');

  await db.company.update({ where: { id: s.companyId }, data: { eInvoiceAttachPdf: false } });
  const inv2 = await issue(s, s.business.id);
  await afterIssue(inv2.id, s.actor);
  const log2 = await db.fiscalLog.findFirstOrThrow({ where: { invoiceId: inv2.id, kind: 'EINVOICE', ok: true }, orderBy: { at: 'desc' } });
  const xml2 = (await invoiceUbl(s.companyId, inv2.id))!.xml!;
  assert.equal(Number(/"bytes":(\d+)/.exec(log2.response ?? '')?.[1]), xml2.length);
});

test('e-pošta: postavke (šifrirana lozinka), predlošci, slanje s PDF-om, ZIP knjigovođi, EmailLog', async () => {
  const s = await setup('mail');
  const inv = await issue(s, s.business.id);
  const sent: Array<Record<string, unknown>> = [];
  setMailTransportFactory(() => {
    const t = nodemailer.createTransport({ jsonTransport: true });
    const orig = t.sendMail.bind(t);
    t.sendMail = (async (m: Parameters<typeof orig>[0]) => {
      const info = await orig(m);
      sent.push(JSON.parse(String((info as { message: string }).message)));
      return info;
    }) as typeof t.sendMail;
    return t;
  });

  // bez SMTP-a: prijedlog kaže da nije podešeno, slanje odbijeno s uputom
  const d0 = await buildEmailDraft(s.user, 'invoice', inv.id);
  assert.equal(d0.configured, false);
  assert.equal(d0.to, 'kupac@kupac.hr');
  assert.equal(d0.subject, `Račun ${inv.number}`);
  assert.match(d0.body, /125,00 €/);
  assert.deepEqual(d0.pdf, { kind: 'invoice', id: inv.id });
  await assert.rejects(sendDocumentEmailImpl(s.user, { kind: 'invoice', id: inv.id, to: 'kupac@kupac.hr', subject: 'x', body: 'y', attachPdf: true }), /nije podešeno/);

  await transaction((tx) =>
    saveMailSettings(tx, s.actor, { smtpHost: 'smtp.test.hr', smtpPort: 587, smtpSecure: false, smtpUser: 'racuni', password: 'tajna-lozinka', clearPassword: false, mailFrom: 'racuni@firma.hr', mailReplyTo: null, mailBccSelf: true }),
  );
  const c = await db.company.findUniqueOrThrow({ where: { id: s.companyId } });
  assert.notEqual(c.smtpPassword, 'tajna-lozinka');
  assert.equal(decryptSecret(c.smtpPassword), 'tajna-lozinka');
  const auditRow = await db.auditLog.findFirstOrThrow({ where: { companyId: s.companyId, action: 'mail-settings' } });
  assert.doesNotMatch(JSON.stringify(auditRow.diff), /tajna-lozinka/);
  // prazna lozinka ne briše postojeću
  await transaction((tx) =>
    saveMailSettings(tx, s.actor, { smtpHost: 'smtp.test.hr', smtpPort: 587, smtpSecure: false, smtpUser: 'racuni', password: null, clearPassword: false, mailFrom: 'racuni@firma.hr', mailReplyTo: null, mailBccSelf: true }),
  );
  assert.equal(decryptSecret((await db.company.findUniqueOrThrow({ where: { id: s.companyId } })).smtpPassword), 'tajna-lozinka');

  // predložak s varijablama
  await transaction((tx) => saveMailTemplates(tx, s.actor, { ...MAIL_DEFAULTS, invoice: { subject: 'Vaš račun {broj} — {firma}', body: 'Iznos {iznos}, dospijeće {dospijece}, kupac {kupac}.' } }));
  const d1 = await buildEmailDraft(s.user, 'invoice', inv.id);
  assert.equal(d1.configured, true);
  assert.ok(d1.subject.startsWith(`Vaš račun ${inv.number} — Firma mail`));
  assert.match(d1.body, /^Iznos 125,00 €, dospijeće \d\d\.\d\d\.\d{4}\.?, kupac Kupac Čćžšđ d\.o\.o\.\.$/);
  const stored = (await db.company.findUniqueOrThrow({ where: { id: s.companyId }, select: { mailTemplates: true } })).mailTemplates as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored), ['invoice'], 'zadani tekstovi se ne spremaju');

  const r = await sendDocumentEmailImpl(s.user, { kind: 'invoice', id: inv.id, to: 'kupac@kupac.hr, drugi@kupac.hr', cc: 'sef@kupac.hr', subject: d1.subject, body: d1.body, attachPdf: true });
  assert.ok(r.messageId);
  const m = sent.at(-1)! as { to: Array<{ address: string }>; cc: Array<{ address: string }>; bcc: Array<{ address: string }>; from: { address: string }; attachments: Array<{ filename: string; content: string; contentType: string }> };
  assert.deepEqual(m.to.map((x) => x.address), ['kupac@kupac.hr', 'drugi@kupac.hr']);
  assert.equal(m.cc[0].address, 'sef@kupac.hr');
  assert.equal(m.bcc[0].address, 'racuni@firma.hr');
  assert.equal(m.from.address, 'racuni@firma.hr');
  assert.equal(m.attachments.length, 1);
  assert.match(m.attachments[0].filename, /^Racun-.+\.pdf$/);
  assert.equal(Buffer.from(m.attachments[0].content, 'base64').subarray(0, 5).toString('latin1'), '%PDF-');
  const log = await db.emailLog.findFirstOrThrow({ where: { companyId: s.companyId, kind: 'invoice', entityId: inv.id } });
  assert.equal(log.status, 'SENT');
  assert.equal(log.to, 'kupac@kupac.hr, drugi@kupac.hr');
  assert.equal(log.sentBy, 'Ana Admin');
  assert.ok(await db.auditLog.findFirst({ where: { companyId: s.companyId, entity: 'invoice', entityId: inv.id, action: 'email' } }));

  // opomena koristi svoj predložak
  const rem = await buildEmailDraft(s.user, 'invoice', inv.id, true);
  assert.match(rem.subject, /^Opomena — račun/);

  // partner: slobodna poruka bez privitka
  await sendDocumentEmailImpl(s.user, { kind: 'partner', id: s.business.id, to: 'kupac@kupac.hr', subject: 'Pozdrav', body: 'Tekst', attachPdf: true });
  assert.equal((sent.at(-1) as { attachments?: unknown[] }).attachments?.length ?? 0, 0);

  // knjigovođa: ZIP s PDF-om i XML-om računa
  const zd = await buildEmailDraft(s.user, 'accountant-zip', `out:${inv.id}`);
  assert.equal(zd.to, 'knjigovodja@ured.hr');
  assert.match(zd.body, new RegExp(`Izlazni ${inv.number!.replace(/[/]/g, '\\/')}`));
  await sendDocumentEmailImpl(s.user, { kind: 'accountant-zip', id: `out:${inv.id}`, to: zd.to, subject: zd.subject, body: zd.body, attachPdf: true });
  const zm = sent.at(-1) as { attachments: Array<{ filename: string; content: string }> };
  assert.match(zm.attachments[0].filename, /^knjigovodja-.+\.zip$/);
  const files = zipEntries(Buffer.from(zm.attachments[0].content, 'base64'));
  const stem = inv.number!.replace(/\//g, '-');
  assert.ok(files.has(`izlazni/${stem}.pdf`));
  assert.ok(files.has(`izlazni/${stem}.xml`));
  assert.equal(files.get(`izlazni/${stem}.pdf`)!.subarray(0, 4).toString('latin1'), '%PDF');
  assert.equal((await db.emailLog.findFirstOrThrow({ where: { companyId: s.companyId, kind: 'accountant-zip' } })).entityId, null);

  // tuđi dokument se ne šalje
  const other = await setup('mail2');
  await assert.rejects(buildEmailDraft(other.user, 'invoice', inv.id), DomainError);
  await assert.rejects(sendDocumentEmailImpl(other.user, { kind: 'quote', id: inv.id, to: 'a@b.hr', subject: 'x', body: '', attachPdf: false }), DomainError);

  // greška SMTP-a: zapis FAILED i razumljiva poruka
  setMailTransportFactory(() => ({ sendMail: async () => { throw Object.assign(new Error('auth'), { code: 'EAUTH' }); } }) as unknown as ReturnType<typeof nodemailer.createTransport>);
  await assert.rejects(sendTestEmail(s.actor, 'ja@firma.hr'), /odbio korisničko ime ili lozinku/);
  const failed = await db.emailLog.findFirstOrThrow({ where: { companyId: s.companyId, kind: 'test' } });
  assert.equal(failed.status, 'FAILED');
});

test('ZIP knjigovođe: PDF izlaznih računa i prilozi troška uz ulazni račun', async () => {
  const s = await setup('zip');
  const inv = await issue(s, s.business.id);
  const si = await db.supplierInvoice.create({ data: { companyId: s.companyId, internalNo: 'URA-1', number: 'R-5/2026', supplierId: s.business.id, issueDate: new Date('2026-03-05'), netAmount: 80, vatAmount: 20, total: 100 } });
  const ex = await db.expense.create({ data: { companyId: s.companyId, date: new Date('2026-03-05'), description: 'Trošak', netAmount: 80, vatAmount: 20, supplierInvoiceId: si.id } });
  await db.attachment.create({ data: { companyId: s.companyId, entity: 'expense', entityId: ex.id, fileName: 'sken.pdf', mime: 'application/pdf', size: 9, data: Buffer.from('%PDF-1.7\n') } });
  const z = await buildAccountantZip(s.companyId, [`out:${inv.id}`, `in:${si.id}`]);
  assert.equal(z.pdfCount, 1);
  const files = zipEntries(z.buffer);
  assert.ok(files.has(`izlazni/${inv.number!.replace(/\//g, '-')}.pdf`));
  assert.ok(files.has('ulazni/R-5-2026/trošak - sken.pdf'));
});
