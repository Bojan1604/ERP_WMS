/**
 * Zajedničko sučelje (krug 2): pretraga partnera za padajuće odabire bez dijakritika
 * („slasticarnica" → „Slastičarnica", „Mandrac" → „Mandrać"), uz ulogu i firmu,
 * te da upit koristi funkcijski trigram indeks iz migracije 0016_unaccent.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanup, setupCompany } from './f-helpers';
import { db } from '../../src/server/db';
import { fromISO, today } from '../../src/domain/dates';
import { findPartnerOptions } from '../../src/server/queries/partner-options';

before(async () => {
  await db.$connect();
  // db push ne zna za funkcijske indekse — primijeni ga iz migracije (IF NOT EXISTS)
  await db.$executeRawUnsafe(readFileSync(new URL('../../prisma/migrations/0016_unaccent/migration.sql', import.meta.url), 'utf8'));
});
after(async () => {
  await cleanup();
  await db.$disconnect();
});

test('pretraga partnera bez dijakritika: naziv, grad, uloga, firma, redoslijed', async () => {
  const s = await setupCompany({ items: 0 });
  const other = await setupCompany({ items: 0 });
  await db.partner.createMany({
    data: [
      { companyId: s.companyId, name: 'Slastičarnica Zagreb' },
      { companyId: s.companyId, name: 'Mandrać d.o.o.', city: 'Šibenik' },
      { companyId: s.companyId, name: 'Slastice Ana' },
      { companyId: s.companyId, name: 'Đakovo trgovina', isCustomer: false, isSupplier: true },
      { companyId: s.companyId, name: 'Popust 50% d.o.o.', oib: '12345678903' },
      { companyId: other.companyId, name: 'Slastičarnica Druga firma' },
    ],
  });
  const names = async (q: string, role?: 'customer' | 'supplier' | 'any' | 'expense') => (await findPartnerOptions(s.companyId, { q, role })).map((p) => p.name);

  assert.deepEqual(await names('slasticarnica'), ['Slastičarnica Zagreb']);
  assert.deepEqual(await names('SLASTIČARNICA'), ['Slastičarnica Zagreb']);
  assert.deepEqual(await names('Mandrac'), ['Mandrać d.o.o.']);
  assert.deepEqual(await names('mandrać'), ['Mandrać d.o.o.']);
  assert.deepEqual(await names('sibenik'), ['Mandrać d.o.o.']); // grad
  assert.deepEqual(await names('slast'), ['Slastice Ana', 'Slastičarnica Zagreb']); // po nazivu
  assert.deepEqual(await names('dakovo', 'supplier'), ['Đakovo trgovina']);
  assert.deepEqual(await names('dakovo', 'customer'), []);
  // doslovna pretraga i OIB od početka ostaju
  assert.deepEqual(await names('50%'), ['Popust 50% d.o.o.']);
  assert.deepEqual(await names('5_%'), []);
  assert.deepEqual(await names('1234567'), ['Popust 50% d.o.o.']);
  // uloga „expense": dobavljači i partneri koji već imaju trošak
  const cat = await db.expenseCategory.findFirstOrThrow({ where: { companyId: s.companyId } });
  await db.expense.create({ data: { companyId: s.companyId, date: fromISO(today()), categoryId: cat.id, description: 'X', partnerId: s.partner.id, netAmount: 1, vatAmount: 0 } });
  const exp = await findPartnerOptions(s.companyId, { role: 'expense', q: s.partner.name.slice(0, 4) });
  assert.ok(exp.some((p) => p.id === s.partner.id));
  // vraćaju se puni podaci za odabir (PDV, rok…)
  const [m] = await findPartnerOptions(s.companyId, { q: 'mandrac' });
  assert.equal(m.city, 'Šibenik');
  assert.ok('paymentTermDays' in m && 'vatCategoryOverride' in m);
});

test('pretraga naziva koristi funkcijski trigram indeks (isti izraz kao u migraciji)', async () => {
  const plan = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    const { FOLD_FROM, FOLD_TO } = await import('../../src/lib/fold');
    return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN SELECT p.id FROM "Partner" p WHERE lower(translate(p."name", '${FOLD_FROM}', '${FOLD_TO}')) LIKE '%slasticarnica%'`,
    );
  });
  const text = plan.map((r) => r['QUERY PLAN']).join('\n');
  assert.match(text, /Partner_name_fold_trgm_idx/);
});
