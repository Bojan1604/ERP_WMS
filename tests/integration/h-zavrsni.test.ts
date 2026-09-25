/**
 * Završni krug — nad testnom bazom: odabir partnera s pretragom na poslužitelju (bez cijelog
 * popisa), doslovna pretraga (% i _), preplata na kartici partnera, rashodi u „Poslovanju"
 * zbrojeni u bazi, skupine marži po stranicama, keširani broj rata izvan Nexta, JIT isključen
 * za veze programa i ANALYZE nakon uvoza.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, setupCompany } from './f-helpers';
import { db, transaction, withJitOff } from '../../src/server/db';
import { fromISO, today } from '../../src/domain/dates';
import { createDraft, issueInvoice } from '../../src/server/services/invoices';
import { findPartnerOptions, partnerOptionsByIds } from '../../src/server/queries/partner-options';
import { partnerCounts, partnerInvoices, partnerOverpaid } from '../../src/server/queries/partners';
import { business, marginGroups, marginGroupsPage, readMarginFilters } from '../../src/server/queries/margins';
import { pendingRentSummary } from '../../src/server/queries/pending-rent';
import { pendingForCompany } from '../../src/server/services/rentals';
import { analyzeAfterImport } from '../../src/server/import/run';
import { listInvoices, readInvoiceFilters } from '../../src/server/queries/sales';

before(async () => {
  await db.$connect();
});
after(async () => {
  await cleanup();
  await db.$disconnect();
});

test('odabir partnera: prvih 20 po nazivu, uloga, doslovna pretraga (% i _), odabrani po id-u', async () => {
  const s = await setupCompany({ items: 0 });
  await db.partner.createMany({
    data: [
      ...Array.from({ length: 25 }, (_, i) => ({ companyId: s.companyId, name: `Kafić ${String(i).padStart(2, '0')}`, city: 'Split' })),
      { companyId: s.companyId, name: 'Popust 50% d.o.o.', oib: '12345678903' },
      { companyId: s.companyId, name: 'Popust 500 d.o.o.' },
      { companyId: s.companyId, name: 'Snake_case obrt' },
      { companyId: s.companyId, name: 'Snakexcase obrt' },
      { companyId: s.companyId, name: 'Samo dobavljač', isCustomer: false, isSupplier: true },
    ],
  });
  const first = await findPartnerOptions(s.companyId, { role: 'customer' });
  assert.equal(first.length, 20);
  assert.deepEqual(first.map((p) => p.name), [...first.map((p) => p.name)].sort((a, b) => a.localeCompare(b, 'en')));
  assert.ok(!first.some((p) => p.name === 'Samo dobavljač'));

  assert.deepEqual((await findPartnerOptions(s.companyId, { q: '50%' })).map((p) => p.name), ['Popust 50% d.o.o.']);
  assert.deepEqual((await findPartnerOptions(s.companyId, { q: 'snake_' })).map((p) => p.name), ['Snake_case obrt']);
  assert.deepEqual((await findPartnerOptions(s.companyId, { q: '1234567' })).map((p) => p.name), ['Popust 50% d.o.o.']);
  assert.equal((await findPartnerOptions(s.companyId, { q: 'split' })).length, 20);

  const sup = await findPartnerOptions(s.companyId, { role: 'supplier' });
  assert.deepEqual(sup.map((p) => p.name).sort(), ['Dobavljač d.o.o.', 'Samo dobavljač']);
  // troškovi: dobavljači i partneri koji su već na troškovima
  const cat = await db.expenseCategory.findFirstOrThrow({ where: { companyId: s.companyId } });
  await db.expense.create({ data: { companyId: s.companyId, date: fromISO(today()), categoryId: cat.id, description: 'X', partnerId: s.partner.id, netAmount: 1, vatAmount: 0 } });
  assert.ok((await findPartnerOptions(s.companyId, { role: 'expense' })).some((p) => p.id === s.partner.id));

  // odabrani (npr. iz URL-a) — i kad nisu među prvih 20, samo iz ove firme
  const other = await setupCompany({ items: 0 });
  const byId = await partnerOptionsByIds(s.companyId, [s.supplier.id, null, other.partner.id, s.supplier.id]);
  assert.deepEqual(byId.map((p) => p.id), [s.supplier.id]);
  assert.deepEqual(await partnerOptionsByIds(s.companyId, []), []);
});

test('doslovna pretraga u popisima: % ne pronalazi sve račune', async () => {
  const s = await setupCompany({ items: 2 });
  await transaction(async (tx) => {
    const d = await createDraft(tx, s.actor, { type: 'SALE', partnerId: s.partner.id, date: today(), vatRate: 25, lines: [{ kind: 'DEVICE', itemId: s.items[0].id, description: 'Sunmi T2s', qty: 1, unitPrice: 200 }] });
    await issueInvoice(tx, s.actor, d.id);
  });
  const page = { page: 1, pageSize: 50, skip: 0, take: 50 };
  assert.equal((await listInvoices(s.companyId, readInvoiceFilters({ q: 'Kupac' }), page)).total, 1);
  assert.equal((await listInvoices(s.companyId, readInvoiceFilters({ q: '%' }), page)).total, 0);
  assert.equal((await listInvoices(s.companyId, readInvoiceFilters({ q: '_' }), page)).total, 0);
});

test('kartica partnera: „Za povrat kupcu" (preplata) uz „Otvoreno"', async () => {
  const s = await setupCompany({ items: 3 });
  const ids = await transaction(async (tx) => {
    const out: string[] = [];
    for (const [i, price] of [200, 100].entries()) {
      const d = await createDraft(tx, s.actor, { type: 'SALE', partnerId: s.partner.id, date: today(), vatRate: 25, lines: [{ kind: 'DEVICE', itemId: s.items[i].id, description: 'Sunmi T2s', qty: 1, unitPrice: price }] });
      await issueInvoice(tx, s.actor, d.id);
      out.push(d.id);
    }
    return out;
  });
  assert.deepEqual(await partnerOverpaid(s.companyId, s.partner.id), { amount: 0, count: 0 });
  // prvi račun plaćen 20 € više (npr. nakon odobrenja), drugi otvoren
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: ids[0] } });
  await db.invoice.update({ where: { id: ids[0] }, data: { paidTotal: Number(inv.grandTotal) + 20, openAmount: 0 } });
  const c = await partnerCounts(s.companyId, s.partner.id);
  assert.equal(c.overpaid, 20);
  assert.equal(c.overpaidCount, 1);
  assert.equal(c.open, 125);
  const tab = await partnerInvoices(s.companyId, s.partner.id, { skip: 0, take: 50 });
  assert.equal(tab.sums.overpaid, 20);
  // storniran račun nema preplate
  await db.invoice.update({ where: { id: ids[0] }, data: { stornoed: true } });
  assert.equal((await partnerOverpaid(s.companyId, s.partner.id)).amount, 0);
});

test('marže → poslovanje: rashodi (jednokratni u bazi, ponavljajući s ratama) po kategoriji i mjesecu', async () => {
  const s = await setupCompany({ items: 0 });
  const year = Number(today().slice(0, 4)) - 1;
  const cat = await db.expenseCategory.create({ data: { companyId: s.companyId, name: 'Z test' } });
  const excluded = await db.partner.create({ data: { companyId: s.companyId, name: 'Interni', excluded: true } });
  const base = { companyId: s.companyId, vatAmount: 0, description: 'x' };
  await db.expense.createMany({
    data: [
      { ...base, date: fromISO(`${year}-02-10`), categoryId: cat.id, netAmount: 100 },
      { ...base, date: fromISO(`${year}-02-20`), categoryId: cat.id, netAmount: 50.5 },
      { ...base, date: fromISO(`${year}-07-01`), categoryId: null, netAmount: 30 },
      { ...base, date: fromISO(`${year}-07-02`), categoryId: cat.id, netAmount: 999, partnerId: excluded.id },
      { ...base, date: fromISO(`${year - 1}-12-31`), categoryId: cat.id, netAmount: 777 },
      // mjesečni od listopada, jedna rata preskočena, jedna izmijenjena
      { ...base, date: fromISO(`${year}-10-05`), categoryId: cat.id, netAmount: 10, frequency: 'MONTHLY', overrides: { [`${year}-11`]: { skipped: true }, [`${year}-12`]: { amount: 15 } } },
    ],
  });
  const b = await business(s.companyId, readMarginFilters({ godina: String(year) }));
  assert.equal(b.expense, 100 + 50.5 + 30 + 10 + 15);
  assert.equal(b.expenseN, 5);
  assert.deepEqual(
    b.expenseByCategory.map((c) => [c.name, c.amount, c.n]),
    [
      ['Z test', 175.5, 4],
      ['Bez kategorije', 30, 1],
    ],
  );
  assert.equal(b.months[1].expense, 150.5);
  assert.equal(b.months[6].expense, 30);
  assert.equal(b.months[10].expense, 0);
  assert.equal(b.months[11].expense, 15);
  // filtar kupca: rashodi bez partnera ostaju, tuđi otpadaju
  const f = await business(s.companyId, readMarginFilters({ godina: String(year), kupac: s.partner.id }));
  assert.equal(f.expense, b.expense);
});

test('marže po kupcu: redoslijed po profitu i straničenje u bazi', async () => {
  const s = await setupCompany({ items: 4 });
  const partners = await Promise.all([1, 2, 3].map((i) => db.partner.create({ data: { companyId: s.companyId, name: `Kupac ${i}` } })));
  await transaction(async (tx) => {
    for (const [i, p] of partners.entries()) {
      const d = await createDraft(tx, s.actor, { type: 'SALE', partnerId: p.id, date: today(), vatRate: 25, lines: [{ kind: 'DEVICE', itemId: s.items[i].id, description: 'Sunmi T2s', qty: 1, unitPrice: 150 + i * 50 }] });
      await issueInvoice(tx, s.actor, d.id);
    }
  });
  const f = readMarginFilters({ pogled: 'kupac' });
  const all = await marginGroups(s.companyId, f, 'kupac');
  assert.deepEqual(all.map((g) => [g.label, g.profit]), [['Kupac 3', 150], ['Kupac 2', 100], ['Kupac 1', 50]]);
  const p2 = await marginGroupsPage(s.companyId, f, 'kupac', { skip: 2, take: 2 });
  assert.equal(p2.total, 3);
  assert.deepEqual(p2.rows.map((g) => g.label), ['Kupac 1']);
  const beyond = await marginGroupsPage(s.companyId, f, 'kupac', { skip: 10, take: 2 });
  assert.deepEqual([beyond.rows.length, beyond.total], [0, 3]);
});

test('broj rata najma izvan Nexta (testovi, skripte) računa se izravno; JIT isključen; ANALYZE nakon uvoza', async () => {
  const s = await setupCompany({ items: 0 });
  const r = await pendingRentSummary(s.companyId);
  assert.deepEqual(r, { count: (await pendingForCompany(db, s.companyId)).length, amount: 0 });

  assert.equal(withJitOff(undefined), undefined);
  assert.match(withJitOff('postgresql://u:p@h:5432/db?schema=public')!, /options=-c\+jit%3Doff/);
  assert.equal(withJitOff('postgresql://u:p@h/db?options=-c%20x%3D1'), 'postgresql://u:p@h/db?options=-c%20x%3D1');
  const [{ jit }] = await db.$queryRaw<Array<{ jit: string }>>`SHOW jit`;
  assert.equal(jit, 'off');

  const logs: string[] = [];
  await analyzeAfterImport(10, (m) => logs.push(m));
  assert.equal(logs.length, 0);
  await analyzeAfterImport(5000, (m) => logs.push(m));
  assert.match(logs[0] ?? '', /ANALYZE/);
});
