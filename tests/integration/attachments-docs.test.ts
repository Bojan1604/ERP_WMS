/**
 * Prilozi uz dokumente (faza 0 prijenosa): nove vrste zapisa, sužavanje na firmu,
 * veličina do 10 MB, brojanje za popise, zaštita izvornog XML-a eRačuna.  npm run test:db
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { Actor } from '../../src/server/services/items';
import {
  addAttachments, ATTACHMENT_ENTITIES, attachmentCounts, attachmentsHideCost, canAttachment, deleteAttachment, listAttachments,
} from '../../src/server/services/attachments';
import { DOC_ATTACHMENT_ENTITIES } from '../../src/domain/attachments';
import { ROLE_DEFAULTS } from '../../src/domain/permissions';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
const pdf = (n = 32) => {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode('%PDF-1.7\n'));
  return b;
};

async function company(tag: string) {
  const c = await db.company.create({ data: { name: `Att ${tag} ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `att${tag}${Date.now()}${Math.random()}@t.hr`, name: 'Admin', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', isSupplier: true } });
  const contract = await db.contract.create({ data: { companyId: c.id, number: 'UG-2026-001', partnerId: partner.id, startDate: new Date('2026-01-01') } });
  const si = await db.supplierInvoice.create({
    data: { companyId: c.id, internalNo: 'URA-2026-001', number: 'R-1', supplierId: partner.id, issueDate: new Date('2026-01-02') },
  });
  return { c, actor, partner, contract, si };
}

after(async () => {
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

test('prilozi dokumenata: vrste, firma, veličina, brojanje i zaštita XML-a', async () => {
  const a = await company('a');
  const b = await company('b');

  // svaka vrsta iz zajedničke komponente postoji u pravilima poslužitelja
  for (const e of DOC_ATTACHMENT_ENTITIES) assert.ok(e in ATTACHMENT_ENTITIES, e);

  const saved = await transaction((tx) => addAttachments(tx, a.actor, 'contract', a.contract.id, [{ fileName: 'potpisan ugovor.pdf', data: pdf() }]));
  assert.equal(saved[0].fileName, 'potpisan ugovor.pdf');
  // tuđa firma ne može dodati prilog na ugovor
  await assert.rejects(transaction((tx) => addAttachments(tx, b.actor, 'contract', a.contract.id, [{ fileName: 'x.pdf', data: pdf() }])), /ne postoji/);
  // dokumenti primaju do 10 MB (uređaj ostaje 2 MB)
  await transaction((tx) => addAttachments(tx, a.actor, 'contract', a.contract.id, [{ fileName: 'sken.pdf', data: pdf(5 * 1024 * 1024) }]));
  await assert.rejects(
    transaction((tx) => addAttachments(tx, a.actor, 'contract', a.contract.id, [{ fileName: 'prevelik.pdf', data: pdf(10 * 1024 * 1024 + 1) }])),
    /veća od 10 MB/,
  );
  const counts = await attachmentCounts(db, a.c.id, 'contract', [a.contract.id, 'nepostojeci']);
  assert.equal(counts.get(a.contract.id), 2);
  assert.equal(counts.get('nepostojeci'), undefined);
  assert.equal((await listAttachments(db, b.c.id, 'contract', [a.contract.id])).length, 0);

  // izvorni XML eRačuna na ulaznom računu se ne briše
  const xml = await db.attachment.create({
    data: { companyId: a.c.id, entity: 'supplierInvoice', entityId: a.si.id, fileName: 'eracun.xml', mime: 'application/xml', size: 5, data: new TextEncoder().encode('<x/>') },
  });
  await assert.rejects(transaction((tx) => deleteAttachment(tx, a.actor, xml.id)), /XML/);
  await transaction((tx) => deleteAttachment(tx, a.actor, saved[0].id));
  await assert.rejects(transaction((tx) => deleteAttachment(tx, b.actor, xml.id)), /ne postoji/);

  // prava po vrsti zapisa
  assert.ok(canAttachment(ROLE_DEFAULTS.SALES, 'invoice', 'add'));
  assert.ok(!canAttachment(ROLE_DEFAULTS.SALES, 'supplierInvoice', 'view'));
  assert.ok(canAttachment(ROLE_DEFAULTS.WAREHOUSE, 'serviceOrder', 'add'));
  assert.ok(!canAttachment(ROLE_DEFAULTS.WAREHOUSE, 'contract', 'view'));
  assert.ok(canAttachment(ROLE_DEFAULTS.ACCOUNTANT, 'expense', 'remove'));
});

test('prilozi dokumenata s nabavnim cijenama skriveni bez prava costs', async () => {
  const a = await company('cost');
  const withCost = ROLE_DEFAULTS.ADMIN;
  const noCost = { ...ROLE_DEFAULTS.ADMIN, costs: 'none' as const };
  // obični ulazni račun (npr. usluga) — vidljiv svima s pravom na nabavu
  assert.equal(await attachmentsHideCost(db, a.c.id, noCost, 'supplierInvoice', a.si.id), false);
  // račun za robu, narudžbenica i primka — skriveni bez prava
  await db.supplierInvoice.update({ where: { id: a.si.id }, data: { goodsInvoice: true } });
  assert.equal(await attachmentsHideCost(db, a.c.id, noCost, 'supplierInvoice', a.si.id), true);
  assert.equal(await attachmentsHideCost(db, a.c.id, noCost, 'purchaseOrder', 'x'), true);
  assert.equal(await attachmentsHideCost(db, a.c.id, noCost, 'receipt', 'x'), true);
  assert.equal(await attachmentsHideCost(db, a.c.id, noCost, 'contract', a.contract.id), false);
  // s pravom — ništa skriveno
  assert.equal(await attachmentsHideCost(db, a.c.id, withCost, 'supplierInvoice', a.si.id), false);
});
