/** Boje firme: spremanje (validacija, zadano = null, dnevnik promjena) i CSS za okvir aplikacije. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { companyColorsSchema, saveCompanyColors } from '../../src/server/services/company-colors';
import { getCompanyColors } from '../../src/server/queries/lookups';
import { companyColorsCss } from '../../src/domain/brand-colors';
import { cleanup, setupCompany } from './f-helpers';

before(async () => {
  await db.$connect();
});
after(async () => {
  await cleanup();
  await db.$disconnect();
});

test('boje firme: shema odbija neispravnu boju, prazno = zadano', () => {
  assert.ok(!companyColorsSchema.safeParse({ brandColor: 'red', menuColor: null }).success);
  assert.ok(!companyColorsSchema.safeParse({ brandColor: '#12345g', menuColor: null }).success);
  assert.ok(!companyColorsSchema.safeParse({ brandColor: '#000;}html{display:none', menuColor: null }).success);
  const r = companyColorsSchema.safeParse({ brandColor: ' #2563EB ', menuColor: '' });
  assert.ok(r.success);
  assert.deepEqual(r.data, { brandColor: '#2563EB', menuColor: null });
  assert.equal(companyColorsSchema.safeParse({ brandColor: 'nije', menuColor: null }).error?.issues[0].message, 'Boja mora biti oblika #rrggbb');
});

test('boje firme: spremanje, dnevnik promjena, vraćanje zadanih', async () => {
  const s = await setupCompany({ items: 0 });
  const saved = await transaction((tx) => saveCompanyColors(tx, s.actor, companyColorsSchema.parse({ brandColor: '#2563EB', menuColor: '#f1f5f9' })));
  assert.deepEqual(saved, { brandColor: '#2563eb', menuColor: '#f1f5f9' });
  assert.deepEqual(await db.company.findUniqueOrThrow({ where: { id: s.companyId }, select: { brandColor: true, menuColor: true } }), saved);
  assert.deepEqual(await getCompanyColors(s.companyId), saved);
  assert.match(companyColorsCss(saved), /--color-nav:#f1f5f9/);

  const logs = await db.auditLog.findMany({ where: { companyId: s.companyId, entity: 'company' }, orderBy: { at: 'asc' } });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].summary, 'Boje firme izmijenjene');
  assert.deepEqual((logs[0].diff as Record<string, unknown>).brandColor, { from: null, to: '#2563eb' });

  // bez promjene → bez zapisa u dnevnik
  await transaction((tx) => saveCompanyColors(tx, s.actor, { brandColor: '#2563eb', menuColor: '#F1F5F9' }));
  assert.equal(await db.auditLog.count({ where: { companyId: s.companyId, entity: 'company' } }), 1);

  // neispravna boja mimo sheme → greška za korisnika, ništa se ne mijenja
  await assert.rejects(transaction((tx) => saveCompanyColors(tx, s.actor, { brandColor: 'url(x)', menuColor: null })), /#rrggbb/);

  // zadana boja se sprema kao null; oba zadana = „vraćene zadane"
  await transaction((tx) => saveCompanyColors(tx, s.actor, { brandColor: '#0d7776', menuColor: null }));
  const c = await db.company.findUniqueOrThrow({ where: { id: s.companyId }, select: { brandColor: true, menuColor: true } });
  assert.deepEqual(c, { brandColor: null, menuColor: null });
  assert.equal(companyColorsCss(c), '');
  assert.equal(await db.auditLog.count({ where: { companyId: s.companyId, entity: 'company', summary: 'Boje firme vraćene na zadane' } }), 1);
});
