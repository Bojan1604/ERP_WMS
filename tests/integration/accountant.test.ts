/**
 * Knjigovođa: oznaka „poslano", izolacija firmi, zbrojevi i ZIP.
 *   npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { createDraft, issueInvoice } from '../../src/server/services/invoices';
import { markAccountantSent } from '../../src/server/services/accountant';
import { listAccountant } from '../../src/server/queries/accountant';
import { buildAccountantZip } from '../../src/server/queries/accountant-export';
import { readAccountantFilters } from '../../src/domain/accountant';
import { DomainError } from '../../src/server/errors';
import { ZipTooLargeError } from '../../src/server/zip';
import { fromISO } from '../../src/domain/dates';
import type { Actor } from '../../src/server/services/items';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
const D = '2026-03-10';
const F = readAccountantFilters({ od: '2026-03-01', do: '2026-03-31' });

async function setup(name: string) {
  const c = await db.company.create({ data: { name: `${name} ${Date.now()}-${Math.random()}`, oib: '12345678903', invoicePremises: 'K1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `k${Date.now()}${Math.random()}@t.hr`, name: 'Knjigovođa', passwordHash: 'x', role: 'ACCOUNTANT' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const customer = await db.partner.create({ data: { companyId: c.id, name: 'Kupac Alfa d.o.o.', oib: '69435151530' } });
  const supplier = await db.partner.create({ data: { companyId: c.id, name: 'Dobavljač Beta', oib: '94577403194', isSupplier: true } });
  const issue = (price: number, date = D) =>
    transaction(async (tx) => {
      const d = await createDraft(tx, actor, { type: 'SERVICE', partnerId: customer.id, date, vatRate: 25, lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: price }] });
      const { number } = await issueInvoice(tx, actor, d.id);
      return { id: d.id, number };
    });
  const inv1 = await issue(100);
  const inv2 = await issue(40);
  await issue(999, '2026-04-02'); // izvan razdoblja
  const draft = await transaction((tx) =>
    createDraft(tx, actor, { type: 'SERVICE', partnerId: customer.id, date: D, vatRate: 25, lines: [{ kind: 'MANUAL', description: 'Nacrt', qty: 1, unitPrice: 5 }] }),
  );
  const si = await db.supplierInvoice.create({
    data: { companyId: c.id, internalNo: 'URA-1', number: 'R-77/2026', supplierId: supplier.id, issueDate: fromISO('2026-03-05'), netAmount: 80, vatAmount: 20, total: 100 },
  });
  await db.attachment.create({
    data: { companyId: c.id, entity: 'supplierInvoice', entityId: si.id, fileName: 'račun.pdf', mime: 'application/pdf', size: 9, data: Buffer.from('%PDF-1.7\n') },
  });
  return { companyId: c.id, actor, inv1, inv2, draft, si };
}

function zipNames(buf: Buffer) {
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
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

test('knjigovođa: popis, zbrojevi iz baze i filtri', async () => {
  const s = await setup('A');
  const list = await listAccountant(s.companyId, F);
  // nacrt i račun izvan razdoblja se ne vide
  assert.deepEqual(list.rows.map((r) => r.key).sort(), [`in:${s.si.id}`, `out:${s.inv1.id}`, `out:${s.inv2.id}`].sort());
  assert.equal(list.totals.out.count, 2);
  assert.equal(list.totals.out.net, 140);
  assert.equal(list.totals.out.vat, 35);
  assert.equal(list.totals.out.total, 175);
  assert.deepEqual({ ...list.totals.in }, { count: 1, net: 80, vat: 20, total: 100, notSent: 1 });
  assert.equal(list.rows.find((r) => r.dir === 'in')!.attachments, 1);
  assert.equal(list.capped, false);

  // pretraga po OIB-u dobavljača i po broju
  const byOib = await listAccountant(s.companyId, { ...F, q: '94577403194' });
  assert.deepEqual(byOib.rows.map((r) => r.id), [s.si.id]);
  const byNo = await listAccountant(s.companyId, { ...F, q: s.inv2.number! });
  assert.ok(byNo.rows.some((r) => r.id === s.inv2.id));
  // samo ulazni
  const inOnly = await listAccountant(s.companyId, { ...F, kind: 'INBOUND' });
  assert.equal(inOnly.totals.out.count, 0);
  assert.equal(inOnly.rows.length, 1);
});

test('knjigovođa: označavanje poslanog i izolacija firmi', async () => {
  const a = await setup('A');
  const b = await setup('B');
  const keys = [`out:${a.inv1.id}`, `in:${a.si.id}`];

  // tuđa firma ne može označiti ni djelomično
  await assert.rejects(() => transaction((tx) => markAccountantSent(tx, b.actor, keys, true)), DomainError);
  await assert.rejects(() => transaction((tx) => markAccountantSent(tx, b.actor, [`out:${b.inv1.id}`, `out:${a.inv2.id}`], true)), DomainError);
  // nacrt se ne označava
  await assert.rejects(() => transaction((tx) => markAccountantSent(tx, a.actor, [`out:${a.draft.id}`], true)), DomainError);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: b.inv1.id } })).accountantSentAt, null);

  const r = await transaction((tx) => markAccountantSent(tx, a.actor, keys, true));
  assert.deepEqual(r, { out: 1, in: 1 });
  assert.ok((await db.invoice.findUniqueOrThrow({ where: { id: a.inv1.id } })).accountantSentAt);
  assert.ok((await db.supplierInvoice.findUniqueOrThrow({ where: { id: a.si.id } })).accountantSentAt);
  assert.equal(await db.auditLog.count({ where: { companyId: a.companyId, entity: 'accountant', action: 'sent' } }), 1);

  const sent = await listAccountant(a.companyId, { ...F, sent: 'da' });
  assert.deepEqual(sent.rows.map((x) => x.key).sort(), keys.sort());
  const notSent = await listAccountant(a.companyId, { ...F, sent: 'ne' });
  assert.deepEqual(notSent.rows.map((x) => x.key), [`out:${a.inv2.id}`]);
  const all = await listAccountant(a.companyId, F);
  assert.equal(all.totals.out.notSent + all.totals.in.notSent, 1);

  await transaction((tx) => markAccountantSent(tx, a.actor, [`in:${a.si.id}`], false));
  assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: a.si.id } })).accountantSentAt, null);
});

test('knjigovođa: ZIP s popisom, eRačun XML-om i prilozima; tuđi dokumenti odbijeni', async () => {
  const a = await setup('A');
  const b = await setup('B');
  const keys = [`out:${a.inv1.id}`, `out:${a.inv2.id}`, `in:${a.si.id}`];
  const z = await buildAccountantZip(a.companyId, keys);
  assert.equal(z.xmlCount, 2);
  assert.equal(z.attCount, 1);
  const files = zipNames(z.buffer);
  const stem = (n: string | null) => n!.replace(/\//g, '-');
  assert.ok(files.has('popis.csv'));
  assert.ok(files.has(`izlazni/${stem(a.inv1.number)}.xml`));
  assert.ok(files.has(`izlazni/${stem(a.inv2.number)}.xml`));
  assert.ok(files.has('ulazni/R-77-2026/račun.pdf'));
  const csv = files.get('popis.csv')!.toString('utf8');
  assert.ok(csv.startsWith('﻿Smjer;Datum;'));
  assert.match(csv, /Ulazni;05\.03\.2026\.?;R-77\/2026;Dobavljač Beta;94577403194;Ulazni račun;80;20;100;Nije plaćeno/);
  assert.match(files.get(`izlazni/${stem(a.inv1.number)}.xml`)!.toString('utf8'), /<Invoice/);

  await assert.rejects(() => buildAccountantZip(b.companyId, keys), DomainError);
  await assert.rejects(() => buildAccountantZip(a.companyId, [`out:${a.draft.id}`]), DomainError);
  await assert.rejects(() => buildAccountantZip(a.companyId, keys, 200), ZipTooLargeError);
});
