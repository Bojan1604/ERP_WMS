/**
 * QA t5 (postavke/korisnici): ne-administrator ne podiže prava (sebi ni drugima),
 * poruka o adminu prije provjere polja, matrica pristupa firmama za korisnike drugih
 * firmi administratora, prihod po klijentu i modelu uključuje usluge i ručne stavke.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { saveUser } from '../../src/server/services/users';
import { setCompanyAccess } from '../../src/server/services/companies';
import { createDraft, issueInvoice } from '../../src/server/services/invoices';
import { findReport, readFilters, runReport } from '../../src/server/queries/reports';
import { saveCompany, type CompanyInput } from '../../src/server/services/settings';
import { today } from '../../src/domain/dates';
import { cleanup, setupCompany } from './f-helpers';

before(async () => {
  await db.$connect();
});
after(async () => {
  await cleanup();
  await db.$disconnect();
});

const uniq = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

test('korisnici: ne-administrator ne mijenja vlastita prava i ne dodjeljuje više od svojih', async () => {
  const s = await setupCompany({ items: 0 });
  // voditelj s pravom na korisnike, bez nabavnih cijena i dnevnika
  const mgrPerms = { users: 'edit', costs: 'none', log: 'none', sales: 'view' };
  const mgr = await db.user.create({ data: { companyId: s.companyId, email: `m${uniq()}@t.hr`, name: 'Voditelj', passwordHash: 'x', role: 'MANAGER', permissions: mgrPerms } });
  const actor = { id: mgr.id, name: mgr.name, companyId: s.companyId };
  const self = { name: 'Voditelj', email: mgr.email, role: 'MANAGER' as const, active: true, password: null };

  // sam sebi: costs/log/razina modula → odbijeno
  await assert.rejects(transaction((tx) => saveUser(tx, actor, mgr.id, { ...self, permissions: { ...mgrPerms, costs: 'view', log: 'view' } })), /vlastitu ulogu ni prava/);
  await assert.rejects(transaction((tx) => saveUser(tx, actor, mgr.id, { ...self, permissions: { ...mgrPerms, sales: 'edit' } })), /vlastitu ulogu ni prava/);
  assert.deepEqual((await db.user.findUniqueOrThrow({ where: { id: mgr.id } })).permissions, mgrPerms);
  // sam sebi bez promjene prava (npr. ime) — dopušteno
  await transaction((tx) => saveUser(tx, actor, mgr.id, { ...self, name: 'Voditelj 2', permissions: mgrPerms }));

  // drugome: pravo koje voditelj nema → odbijeno; razina ≤ vlastite → dopušteno
  const base = { name: 'Prodavač', email: `p${uniq()}@t.hr`, role: 'SALES' as const, active: true, password: 'lozinka123' };
  await assert.rejects(transaction((tx) => saveUser(tx, actor, null, { ...base, role: 'WAREHOUSE', permissions: { costs: 'view' } })), /Nabavne cijene/);
  await assert.rejects(transaction((tx) => saveUser(tx, actor, null, { ...base, permissions: { sales: 'edit' } })), /Prodaja i računi/, 'SALES zadano ima sales:edit > voditeljev view');
  const sid = await transaction((tx) => saveUser(tx, actor, null, { ...base, role: 'WAREHOUSE', permissions: { sales: 'view', warehouse: 'view' } }));
  await assert.rejects(transaction((tx) => saveUser(tx, actor, sid, { ...base, role: 'WAREHOUSE', password: null, permissions: { sales: 'view', log: 'view' } })), /Dnevnik promjena/);

  // administrator smije sve
  await transaction((tx) => saveUser(tx, s.actor, mgr.id, { ...self, permissions: { ...mgrPerms, costs: 'view' } }));
});

test('korisnici: ne-administrator koji mijenja lozinku administratora dobiva pravu poruku', async () => {
  const s = await setupCompany({ items: 0 });
  const mgr = await db.user.create({ data: { companyId: s.companyId, email: `m${uniq()}@t.hr`, name: 'Voditelj', passwordHash: 'x', role: 'MANAGER', permissions: { users: 'edit' } } });
  const actor = { id: mgr.id, name: mgr.name, companyId: s.companyId };
  await assert.rejects(
    transaction((tx) => saveUser(tx, actor, s.user.id, { name: s.user.name, email: s.user.email, role: 'ADMIN', active: true, password: 'Hacked12345', permissions: {} })),
    /Samo administrator može mijenjati podatke administratora/,
  );
});

test('firme: administrator daje pristup korisniku druge svoje firme (ne samo trenutne)', async () => {
  const a = await setupCompany({ items: 0 });
  const b = await setupCompany({ items: 0 });
  const c = await setupCompany({ items: 0 });
  // administrator firme A ima pristup i firmi B; korisnik je samo u firmi B
  await db.userCompany.createMany({ data: [{ userId: a.user.id, companyId: a.companyId }, { userId: a.user.id, companyId: b.companyId }] });
  const worker = await db.user.create({ data: { companyId: b.companyId, email: `w${uniq()}@t.hr`, name: 'Radnik B', passwordHash: 'x', role: 'SALES' } });
  await transaction((tx) => setCompanyAccess(tx, a.actor, worker.id, a.companyId, true));
  assert.ok(await db.userCompany.findUnique({ where: { userId_companyId: { userId: worker.id, companyId: a.companyId } } }));
  await transaction((tx) => setCompanyAccess(tx, a.actor, worker.id, a.companyId, false));
  assert.equal(await db.userCompany.count({ where: { userId: worker.id, companyId: a.companyId } }), 0);
  // korisnik firme kojoj administrator nema pristup — i dalje odbijeno
  const stranger = await db.user.create({ data: { companyId: c.companyId, email: `x${uniq()}@t.hr`, name: 'Tuđi', passwordHash: 'x', role: 'SALES' } });
  await assert.rejects(transaction((tx) => setCompanyAccess(tx, a.actor, stranger.id, a.companyId, true)), /Korisnik ne postoji/);
});

test('postavke: najam (% nabavne) mora biti 0–100', async () => {
  const s = await setupCompany({ items: 0 });
  const c = s.company;
  const input: CompanyInput = {
    name: c.name, country: 'HR', currency: 'EUR', vatRegistered: true, vatRate: 25, overdueDays: 30, paymentTermDays: 15, quoteValidDays: 15,
    defaultMarginPct: 20, defaultWarrantyMonths: 12, rentFallbackPct: -5, invoicePremises: 'T1', invoiceDevice: '1', invoiceSeparator: '/', invoiceFooter: null,
    statusChangeNeedsApproval: false, oib: null, vatId: null, address: null, city: null, zip: null, iban: null, bank: null, email: null, accountantEmail: null, phone: null, web: null,
  };
  await assert.rejects(transaction((tx) => saveCompany(tx, s.actor, input)), /između 0 i 100/);
  await assert.rejects(transaction((tx) => saveCompany(tx, s.actor, { ...input, rentFallbackPct: 150 })), /između 0 i 100/);
});

test('izvještaj: prihod po klijentu i modelu uključuje usluge i ručne stavke (zbroj = Prihod po mjesecima → Prodaja)', async () => {
  const s = await setupCompany({ items: 2 });
  const year = Number(today().slice(0, 4));
  const svc = await db.service.create({ data: { companyId: s.companyId, name: 'Instalacija', price: 40 } });
  const draft = await transaction((tx) =>
    createDraft(tx, s.actor, {
      type: 'SALE', partnerId: s.partner.id, date: `${year}-02-10`, vatRate: 25,
      lines: [
        { kind: 'DEVICE', itemId: s.items[0].id, modelId: s.model.id, description: 'Sunmi T2s', qty: 1, unitPrice: 200 },
        { kind: 'SERVICE', serviceId: svc.id, description: 'Instalacija', qty: 2, unitPrice: 40 },
        { kind: 'MANUAL', description: 'Dostava', qty: 1, unitPrice: 15 },
      ],
    }),
  );
  await transaction((tx) => issueInvoice(tx, s.actor, draft.id));
  const run = async (slug: string) => {
    const def = findReport(slug)!;
    return runReport(def, s.companyId, readFilters(def, new URLSearchParams({ godina: String(year) })), { canSeeCost: true });
  };
  const cm = await run('prihod-klijent-model');
  const byModel = Object.fromEntries(cm.rows.map((r) => [r.model as string, r.revenue as number]));
  assert.deepEqual(byModel, { 'Sunmi T2s': 200, Usluge: 80, 'Ručne stavke': 15 });
  const months = await run('prihod-po-mjesecima');
  const sale = months.rows.reduce((a, r) => a + Number(r.sale ?? 0), 0);
  assert.equal(cm.rows.reduce((a, r) => a + (r.revenue as number), 0), sale);
});
