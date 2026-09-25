/**
 * Područje F — sigurnost i sustav: prijava u dva koraka (uključivanje, drugi
 * korak, rezervni kodovi, poništavanje), više firmi (izolacija i prebacivanje),
 * automatsko izdavanje rata (idempotentno i uz dva procesa), vlastiti račun.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { generate } from 'otplib';
import { db, transaction } from '../../src/server/db';
import {
  checkSecondFactor, confirmTotpSetup, disableOwnTotp, regenerateBackupCodes, resetUserTotp, startTotpSetup,
} from '../../src/server/services/two-factor';
import { decryptSecret } from '../../src/server/fiscal/crypto';
import { accessibleCompanies, createCompany, deleteCompany, setCompanyAccess, switchCompany } from '../../src/server/services/companies';
import { changeOwnPassword, saveUser, updateOwnProfile } from '../../src/server/services/users';
import { autoIssueCompany, runAutoIssue } from '../../src/server/jobs/auto-issue';
import { findReport, readFilters, runReport } from '../../src/server/queries/reports';
import { addMonths, fromISO, today } from '../../src/domain/dates';
import { cleanup, companies, setupCompany } from './f-helpers';

before(async () => {
  await db.$connect();
});
after(async () => {
  await cleanup();
  await db.$disconnect();
});

test('2FA: uključivanje s QR kodom, drugi korak prijave, rezervni kod vrijedi jednom, isključivanje i poništavanje', async () => {
  const s = await setupCompany({ items: 0 });
  await db.user.update({ where: { id: s.user.id }, data: { passwordHash: await bcrypt.hash('lozinka123', 4) } });
  const setup = await transaction((tx) => startTotpSetup(tx, s.actor));
  assert.match(setup.qr, /^data:image\/png;base64,/);
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  const row = await db.user.findUniqueOrThrow({ where: { id: s.user.id } });
  assert.ok(row.totpSecret?.startsWith('v1:'), 'tajna je šifrirana');
  assert.equal(decryptSecret(row.totpSecret), setup.secret);
  assert.equal(row.totpEnabled, false);
  // bez uključene 2FA drugi korak ne postoji
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, '123456')), null);

  await assert.rejects(transaction((tx) => confirmTotpSetup(tx, s.actor, '000000')), /Kod nije ispravan/);
  // potvrda kodom prethodnog koraka (unutar tolerancije); taj se korak više ne prihvaća
  const now = () => Math.floor(Date.now() / 1000);
  const codes = await transaction(async (tx) => confirmTotpSetup(tx, s.actor, await generate({ secret: setup.secret, epoch: now() - 30 })));
  assert.equal(codes.length, 10);
  const enabled = await db.user.findUniqueOrThrow({ where: { id: s.user.id } });
  assert.equal(enabled.totpEnabled, true);
  assert.equal(enabled.backupCodes.length, 10);
  assert.ok(!enabled.backupCodes.includes(codes[0]), 'u bazi su samo sažeci');

  // drugi korak: TOTP, pogrešan kod, rezervni kod (jednom), rezervni kod velikim slovima i bez crtice
  const current = await generate({ secret: setup.secret });
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, current)), 'totp');
  // isti kod (isti korak) drugi put ne prolazi — zaštita od ponovne uporabe
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, current)), null, 'iskorišten TOTP kod ne vrijedi');
  assert.ok((await db.user.findUniqueOrThrow({ where: { id: s.user.id } })).totpLastStep);
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, '999999')), null);
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, codes[0])), 'backup');
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, codes[0])), null, 'iskorišten rezervni kod ne vrijedi');
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, codes[1].toUpperCase().replace('-', ''))), 'backup');
  // istodobne prijave istim kodom — prolazi samo jedna
  const race = await Promise.all([1, 2, 3].map(() => transaction((tx) => checkSecondFactor(tx, s.user.id, codes[2]))));
  assert.equal(race.filter((r) => r === 'backup').length, 1);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: s.user.id } })).backupCodes.length, 7);

  // novi rezervni kodovi zamjenjuju stare
  await assert.rejects(transaction((tx) => regenerateBackupCodes(tx, s.actor, current)), /već iskorišten/);
  const fresh = await transaction(async (tx) => regenerateBackupCodes(tx, s.actor, await generate({ secret: setup.secret, epoch: now() + 30 })));
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, codes[3])), null);
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, fresh[0])), 'backup');

  // isključivanje traži lozinku
  await assert.rejects(transaction((tx) => disableOwnTotp(tx, s.actor, 'kriva')), /Lozinka nije ispravna/);
  await transaction((tx) => disableOwnTotp(tx, s.actor, 'lozinka123'));
  const off = await db.user.findUniqueOrThrow({ where: { id: s.user.id } });
  assert.equal(off.totpEnabled, false);
  assert.equal(off.totpSecret, null);

  // administrator poništava 2FA drugom korisniku (izgubljen mobitel) — sesije se odjavljuju
  const u2 = await db.user.create({ data: { companyId: s.companyId, email: `z${Math.random()}@t.hr`, name: 'Zaposlenik', passwordHash: 'x', role: 'SALES' } });
  const a2 = { id: u2.id, name: u2.name, companyId: s.companyId };
  const s2 = await transaction((tx) => startTotpSetup(tx, a2));
  await transaction(async (tx) => confirmTotpSetup(tx, a2, await generate({ secret: s2.secret })));
  await db.session.create({ data: { userId: u2.id, tokenHash: `h${Math.random()}`, expiresAt: new Date(Date.now() + 3_600_000) } });
  await transaction((tx) => resetUserTotp(tx, s.actor, u2.id, s.companyId));
  const r2 = await db.user.findUniqueOrThrow({ where: { id: u2.id } });
  assert.equal(r2.totpEnabled, false);
  assert.equal(await db.session.count({ where: { userId: u2.id, revokedAt: null } }), 0);
  // korisnik druge firme se ne može poništiti
  const other = await setupCompany({ items: 0 });
  await assert.rejects(transaction((tx) => resetUserTotp(tx, s.actor, other.user.id, s.companyId)), /ne postoji/);
});

test('moj račun: ime i lozinka (uz trenutnu), odjava ostalih uređaja', async () => {
  const s = await setupCompany({ items: 0 });
  await db.user.update({ where: { id: s.user.id }, data: { passwordHash: await bcrypt.hash('stara1234', 4) } });
  await db.session.create({ data: { userId: s.user.id, tokenHash: `m${Math.random()}`, expiresAt: new Date(Date.now() + 3_600_000) } });
  await transaction((tx) => updateOwnProfile(tx, s.actor, { name: 'Novo Ime' }));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: s.user.id } })).name, 'Novo Ime');
  await assert.rejects(transaction((tx) => changeOwnPassword(tx, s.actor, { current: 'kriva', next: 'nova12345' })), /Trenutna lozinka/);
  await assert.rejects(transaction((tx) => changeOwnPassword(tx, s.actor, { current: 'stara1234', next: 'kratka' })), /barem 8/);
  await transaction((tx) => changeOwnPassword(tx, s.actor, { current: 'stara1234', next: 'nova12345' }));
  const u = await db.user.findUniqueOrThrow({ where: { id: s.user.id } });
  assert.ok(await bcrypt.compare('nova12345', u.passwordHash));
  assert.equal(await db.session.count({ where: { userId: s.user.id, revokedAt: null } }), 0);
});

test('prava: opasna zona i odobrenje statusa po korisniku dodjeljuje administrator', async () => {
  const s = await setupCompany({ items: 0 });
  const base = { name: 'Skladištar', email: `sk${Math.random()}@t.hr`, role: 'WAREHOUSE' as const, active: true, password: 'lozinka123', permissions: {} };
  const id = await transaction((tx) => saveUser(tx, s.actor, null, { ...base, canDanger: true, requireApproval: true }));
  let u = await db.user.findUniqueOrThrow({ where: { id } });
  assert.equal(u.canDanger, true);
  assert.equal(u.requireApproval, true);
  assert.ok(await db.userCompany.findUnique({ where: { userId_companyId: { userId: id, companyId: s.companyId } } }), 'novi korisnik ima pristup firmi');
  await transaction((tx) => saveUser(tx, s.actor, id, { ...base, password: null, canDanger: false, requireApproval: null }));
  u = await db.user.findUniqueOrThrow({ where: { id } });
  assert.equal(u.canDanger, false);
  assert.equal(u.requireApproval, null);
  // voditelj ne dodjeljuje opasnu zonu
  const mgr = await db.user.create({ data: { companyId: s.companyId, email: `m${Math.random()}@t.hr`, name: 'Voditelj', passwordHash: 'x', role: 'MANAGER' } });
  await assert.rejects(transaction((tx) => saveUser(tx, { id: mgr.id, name: mgr.name, companyId: s.companyId }, id, { ...base, password: null, canDanger: true })), /samo administrator/);
});

test('više firmi: nova firma sa šifrarnicima, prebacivanje samo uz pristup, izolacija podataka, brisanje samo prazne', async () => {
  const a = await setupCompany({ items: 3 });
  const b = await transaction((tx) => createCompany(tx, a.actor, { name: `Beograd ${Math.random()}`, country: 'RS', currency: 'RSD', copyLookups: true }));
  companies.push(b.id);
  assert.equal(Number(b.vatRate), 20);
  assert.equal(await db.deviceModel.count({ where: { companyId: b.id } }), 1, 'modeli preslikani');
  const copied = await db.deviceModel.findFirstOrThrow({ where: { companyId: b.id }, include: { category: true } });
  assert.equal(copied.category?.companyId, b.id, 'kategorija modela je u novoj firmi');
  assert.equal(await db.itemStatus.count({ where: { companyId: b.id, system: true } }), 7);
  assert.equal(await db.item.count({ where: { companyId: b.id } }), 0, 'bez uređaja');
  assert.deepEqual((await accessibleCompanies(db, a.user.id)).map((c) => c.id).sort(), [a.companyId, b.id].sort());

  // prebacivanje mijenja trenutnu firmu; podaci se čitaju samo iz nje
  await transaction((tx) => switchCompany(tx, a.actor, b.id));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: a.user.id } })).companyId, b.id);
  const def = findReport('stanje-po-statusima')!;
  const inB = await runReport(def, b.id, readFilters(def, new URLSearchParams()), { canSeeCost: true });
  assert.equal(inB.rows.reduce((x, r) => x + Number(r.count), 0), 0);
  const inA = await runReport(def, a.companyId, readFilters(def, new URLSearchParams()), { canSeeCost: true });
  assert.equal(inA.rows.reduce((x, r) => x + Number(r.count), 0), 3);
  // povratak u matičnu firmu
  await transaction((tx) => switchCompany(tx, { ...a.actor, companyId: b.id }, a.companyId));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: a.user.id } })).companyId, a.companyId);

  // korisnik bez pristupa ne može prijeći
  const sales = await db.user.create({ data: { companyId: a.companyId, email: `p${Math.random()}@t.hr`, name: 'Prodavač', passwordHash: 'x', role: 'SALES' } });
  const sa = { id: sales.id, name: sales.name, companyId: a.companyId };
  await assert.rejects(transaction((tx) => switchCompany(tx, sa, b.id)), /Nemate pristup/);
  await transaction((tx) => setCompanyAccess(tx, a.actor, sales.id, b.id, true));
  await transaction((tx) => switchCompany(tx, sa, b.id));
  // pristup firmi u kojoj korisnik radi ne može se oduzeti
  await assert.rejects(transaction((tx) => setCompanyAccess(tx, a.actor, sales.id, b.id, false)), /trenutno radi/);
  await transaction((tx) => switchCompany(tx, { ...sa, companyId: b.id }, a.companyId));
  await transaction((tx) => setCompanyAccess(tx, a.actor, sales.id, b.id, false));
  await assert.rejects(transaction((tx) => switchCompany(tx, sa, b.id)), /Nemate pristup/);
  // tuđa firma (bez pristupa administratora)
  const foreign = await setupCompany({ items: 0 });
  await assert.rejects(transaction((tx) => switchCompany(tx, a.actor, foreign.companyId)), /Nemate pristup/);

  // brisanje: ne trenutna, ne s podacima, naziv mora odgovarati
  await assert.rejects(transaction((tx) => deleteCompany(tx, a.actor, a.companyId, 'x')), /trenutno radite/);
  await assert.rejects(transaction((tx) => deleteCompany(tx, a.actor, b.id, 'kriv naziv')), /ne odgovara/);
  await db.partner.create({ data: { companyId: b.id, name: 'Kupac BG' } });
  await assert.rejects(transaction((tx) => deleteCompany(tx, a.actor, b.id, b.name)), /nije prazna/);
  await db.partner.deleteMany({ where: { companyId: b.id } });
  await transaction((tx) => deleteCompany(tx, a.actor, b.id, b.name));
  assert.equal(await db.company.findUnique({ where: { id: b.id } }), null);
  assert.equal(await db.userCompany.count({ where: { companyId: b.id } }), 0);
});

test('automatsko izdavanje rata: jednom dnevno, idempotentno i uz dva istodobna procesa', async () => {
  const s = await setupCompany({ items: 2 });
  const start = `${addMonths(today(), -2).slice(0, 7)}-01`;
  const contract = await db.contract.create({ data: { companyId: s.companyId, number: `UG-A-${Math.random()}`, partnerId: s.partner.id, startDate: fromISO(start), billing: 'MONTHLY' } });
  const { attachItems } = await import('../../src/server/services/rentals');
  await transaction((tx) => attachItems(tx, s.actor, contract.id, [{ itemId: s.items[0].id, monthly: 20 }, { itemId: s.items[1].id, monthly: 30 }], { issueDate: start }));

  // bez uključene opcije dnevni posao firmu preskače
  assert.ok(!(await runAutoIssue()).some((r) => r.companyId === s.companyId));
  await db.company.update({ where: { id: s.companyId }, data: { autoIssueRent: true, autoIssueSince: fromISO(start) } });

  const [a, b] = await Promise.all([autoIssueCompany(s.companyId, { fiscalize: false }), autoIssueCompany(s.companyId, { fiscalize: false })]);
  const issued = a.issued.length + b.issued.length;
  assert.equal(issued, 3, 'tri rate (dva prošla mjeseca + tekući)');
  assert.ok(a.alreadyRan || b.alreadyRan, 'drugi proces ne radi posao');
  assert.equal(await db.invoice.count({ where: { companyId: s.companyId, status: 'ISSUED', type: 'RENT' } }), 3);
  const numbers = (await db.invoice.findMany({ where: { companyId: s.companyId, status: 'ISSUED' }, select: { number: true } })).map((i) => i.number);
  assert.equal(new Set(numbers).size, numbers.length, 'bez dvostrukih brojeva');

  // isti dan ponovno — ništa; „Pokreni sada" (force) — nema novih rata, bez duplikata
  assert.equal((await autoIssueCompany(s.companyId, { fiscalize: false })).alreadyRan, true);
  const forced = await autoIssueCompany(s.companyId, { force: true, fiscalize: false });
  assert.equal(forced.issued.length, 0);
  assert.equal(forced.errors.length, 0);
  assert.equal(await db.invoice.count({ where: { companyId: s.companyId, status: 'ISSUED', type: 'RENT' } }), 3);
  // trag u dnevniku: pokretanje i sažetak, računi u ime „Automatsko izdavanje"
  const logs = await db.auditLog.findMany({ where: { companyId: s.companyId, entity: 'job' } });
  assert.ok(logs.some((l) => l.entityId?.endsWith(':done') && /izdano 3/.test(l.summary)));
  assert.ok(await db.auditLog.findFirst({ where: { companyId: s.companyId, entity: 'contract', action: 'issue', userName: 'Automatsko izdavanje' } }));
});
