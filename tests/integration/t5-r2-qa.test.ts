/**
 * QA t5 krug 2: ne-administrator s users:edit ne preuzima račun korisnika s višim pravima
 * (lozinka, e-adresa, aktivnost, 2FA, odjava); raspodjela popusta na stavke do centa
 * („Prihod po klijentu i modelu" = „Prihod po mjesecima → Prodaja"); Top kupci: stupac Usluge.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { revokeUserSessions, saveUser } from '../../src/server/services/users';
import { resetUserTotp } from '../../src/server/services/two-factor';
import { createDraft, issueInvoice } from '../../src/server/services/invoices';
import { findReport, readFilters, runReport } from '../../src/server/queries/reports';
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

test('korisnici: ne-administrator ne mijenja korisnika s višim pravima (preuzimanje računa)', async () => {
  const s = await setupCompany({ items: 0 });
  const mgrPerms = { users: 'edit', costs: 'none', log: 'none', sales: 'view' };
  const mgr = await db.user.create({ data: { companyId: s.companyId, email: `m${uniq()}@t.hr`, name: 'Voditelj', passwordHash: 'x', role: 'MANAGER', permissions: mgrPerms } });
  const actor = { id: mgr.id, name: mgr.name, companyId: s.companyId };
  const mk = (name: string, data: { permissions?: object; canDanger?: boolean }) =>
    db.user.create({ data: { companyId: s.companyId, email: `${name}${uniq()}@t.hr`, name, passwordHash: 'stari', role: 'WAREHOUSE', totpEnabled: true, totpSecret: 'x', ...data, permissions: { sales: 'view', ...(data.permissions ?? {}) } } });
  const withCosts = await mk('Nabavna', { permissions: { costs: 'view' } });
  const withLog = await mk('Dnevnik', { permissions: { log: 'view' } });
  const withDanger = await mk('Opasna', { canDanger: true });
  const higherLevel = await mk('Prodaja', { permissions: { sales: 'edit' } });

  for (const t of [withCosts, withLog, withDanger, higherLevel]) {
    await db.session.create({ data: { userId: t.id, tokenHash: `h${uniq()}`, expiresAt: new Date(Date.now() + 86_400_000) } });
    const same = { name: t.name, email: t.email, role: 'WAREHOUSE' as const, active: true, password: null, permissions: t.permissions as Record<string, string> };
    // lozinka, e-adresa, deaktivacija (umjesto brisanja — pojedinačnog brisanja korisnika nema), 2FA, odjava
    await assert.rejects(transaction((tx) => saveUser(tx, actor, t.id, { ...same, password: 'Preuzeto123' })), /administrator/, `${t.name}: lozinka`);
    await assert.rejects(transaction((tx) => saveUser(tx, actor, t.id, { ...same, email: `napadac${uniq()}@t.hr` })), /administrator/, `${t.name}: e-adresa`);
    await assert.rejects(transaction((tx) => saveUser(tx, actor, t.id, { ...same, active: false })), /administrator/, `${t.name}: aktivnost`);
    await assert.rejects(transaction((tx) => resetUserTotp(tx, actor, t.id, s.companyId)), /administrator/, `${t.name}: 2FA`);
    await assert.rejects(transaction((tx) => revokeUserSessions(tx, actor, t.id)), /administrator/, `${t.name}: odjava`);
    const after = await db.user.findUniqueOrThrow({ where: { id: t.id } });
    assert.equal(after.passwordHash, 'stari');
    assert.equal(after.email, t.email);
    assert.ok(after.active && after.totpEnabled);
    assert.equal(await db.session.count({ where: { userId: t.id, revokedAt: null } }), 1);
  }

  // korisnik s pravima ⊆ vlastitih — dopušteno (lozinka, odjava, 2FA)
  const peer = await mk('Ravan', {});
  await transaction((tx) => saveUser(tx, actor, peer.id, { name: peer.name, email: peer.email, role: 'WAREHOUSE', active: true, password: 'NovaLozinka1', permissions: { sales: 'view' } }));
  await transaction((tx) => revokeUserSessions(tx, actor, peer.id));
  await transaction((tx) => resetUserTotp(tx, actor, peer.id, s.companyId));
  // administrator smije sve
  await transaction((tx) => revokeUserSessions(tx, s.actor, withDanger.id));
  await transaction((tx) => saveUser(tx, s.actor, withCosts.id, { name: withCosts.name, email: withCosts.email, role: 'WAREHOUSE', active: true, password: 'NovaLozinka1', permissions: { sales: 'view', costs: 'view' } }));
});

test('izvještaj: popust na račun raspoređen do centa — klijent/model = Prihod po mjesecima; Top kupci s Uslugama', async () => {
  const s = await setupCompany({ items: 1 });
  const year = Number(today().slice(0, 4));
  const svc = await db.service.create({ data: { companyId: s.companyId, name: 'Instalacija', price: 10 } });
  const draft = await transaction((tx) =>
    createDraft(tx, s.actor, {
      type: 'SALE', partnerId: s.partner.id, date: `${year}-02-10`, vatRate: 25, discountAmount: 0.01,
      lines: [
        { kind: 'DEVICE', itemId: s.items[0].id, modelId: s.model.id, description: 'Sunmi T2s', qty: 1, unitPrice: 10 },
        { kind: 'SERVICE', serviceId: svc.id, description: 'Instalacija', qty: 1, unitPrice: 10 },
        { kind: 'MANUAL', description: 'Dostava', qty: 1, unitPrice: 10 },
      ],
    }),
  );
  await transaction((tx) => issueInvoice(tx, s.actor, draft.id));
  // račun vrste usluga — Top kupci: Prodaja + Najam + Usluge = Ukupno
  const sd = await transaction((tx) =>
    createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: `${year}-03-10`, vatRate: 25, lines: [{ kind: 'SERVICE', serviceId: svc.id, description: 'Instalacija', qty: 1, unitPrice: 50 }] }),
  );
  await transaction((tx) => issueInvoice(tx, s.actor, sd.id));
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(Number(inv.netTotal), 29.99);

  const run = async (slug: string) => {
    const def = findReport(slug)!;
    return runReport(def, s.companyId, readFilters(def, new URLSearchParams({ godina: String(year) })), { canSeeCost: true });
  };
  const cm = await run('prihod-klijent-model');
  const cents = (v: number) => Math.round(v * 100);
  // bez raspodjele do centa svaki red bi bio 10,00 (ukupno 30,00 ≠ 29,99)
  assert.equal(cm.rows.reduce((a, r) => a + cents(r.revenue as number), 0), 2999);
  const months = await run('prihod-po-mjesecima');
  assert.equal(cents(months.rows.reduce((a, r) => a + Number(r.sale ?? 0), 0)), 2999);

  const top = await run('top-kupci');
  const row = top.rows.find((r) => r.name === s.partner.name)!;
  assert.ok(top.columns.some((c) => c.key === 'service'));
  assert.equal(cents(Number(row.service)), 5000);
  assert.equal(cents(Number(row.sale)) + cents(Number(row.rent)) + cents(Number(row.service)), cents(Number(row.net)));
});
