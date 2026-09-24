/**
 * MDM portal: izolacija opsega (vlasnik / distributer / klijent), upis kodom,
 * organizacije i vanjski korisnici — nad testnom bazom.
 *   npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { db, transaction } from '../../src/server/db';
import { getMdmScope, type MdmScope } from '../../src/server/mdm/scope';
import type { SessionUser } from '../../src/server/auth';
import { queueCommands } from '../../src/server/mdm/commands';
import { assignProfile, moveDevices, updateDevice, linkItem } from '../../src/server/mdm/devices';
import { enrollByCode, createEnrollToken } from '../../src/server/mdm/enroll';
import { deleteOrg, saveOrg, saveSite } from '../../src/server/mdm/orgs';
import { saveMdmUser, setMdmUserActive } from '../../src/server/mdm/users';
import { getDevice, getOrg, listDevices, mdmDashboard, orgOptions, parseDeviceFilters } from '../../src/server/queries/mdm';
import { resolvePermissions, type RoleCode } from '../../src/domain/permissions';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
const PAGE = { skip: 0, take: 100 };

async function mkDevice(companyId: string, data: { orgId?: string | null; siteId?: string | null; name: string; status?: 'PENDING' | 'ENROLLED' | 'RETIRED'; enrollCode?: string; platform?: 'ANDROID' | 'WINDOWS'; lastSeenAt?: Date | null; batteryLevel?: number }) {
  return db.mdmDevice.create({
    data: {
      companyId,
      orgId: data.orgId ?? null,
      siteId: data.siteId ?? null,
      name: data.name,
      platform: data.platform ?? 'ANDROID',
      status: data.status ?? 'ENROLLED',
      enrollCode: data.enrollCode ?? null,
      tokenHash: createHash('sha256').update(randomBytes(16)).digest('hex'),
      lastSeenAt: data.lastSeenAt === undefined ? new Date() : data.lastSeenAt,
      batteryLevel: data.batteryLevel ?? null,
      enrolledAt: data.status === 'PENDING' ? null : new Date(),
    },
  });
}

async function mkUser(companyId: string, role: RoleCode, mdmOrgId: string | null) {
  return db.user.create({
    data: { companyId, email: `mdm${Date.now()}${Math.random()}@t.hr`, name: `${role} korisnik`, passwordHash: 'x', role, mdmOrgId },
  });
}

async function scopeFor(u: { id: string; name: string; email: string; role: RoleCode; companyId: string; mdmOrgId: string | null }): Promise<MdmScope> {
  const su: SessionUser = {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    companyId: u.companyId,
    companyName: 'Test',
    perms: resolvePermissions(u.role, {}),
    mdmOrgId: u.role === 'DISTRIBUTOR' || u.role === 'CLIENT' ? u.mdmOrgId : null,
    mdmOrgName: null,
  };
  return getMdmScope(su);
}

/** Firma vlasnik → distributeri A i B → klijenti A1, A2, B1; po uređaj u svakom i jedan na čekanju. */
async function setup() {
  const c = await db.company.create({ data: { name: `MDM test ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  const id = c.id;
  const org = (name: string, type: 'DISTRIBUTOR' | 'CUSTOMER', parentId: string | null = null) => db.mdmOrg.create({ data: { companyId: id, name, type, parentId } });
  const A = await org('Distributer A', 'DISTRIBUTOR');
  const B = await org('Distributer B', 'DISTRIBUTOR');
  const A1 = await org('Klijent A1', 'CUSTOMER', A.id);
  const A2 = await org('Klijent A2', 'CUSTOMER', A.id);
  const B1 = await org('Klijent B1', 'CUSTOMER', B.id);
  const siteA1 = await db.mdmSite.create({ data: { orgId: A1.id, name: 'Lokal A1' } });
  const siteA2 = await db.mdmSite.create({ data: { orgId: A2.id, name: 'Lokal A2' } });
  const devA1 = await mkDevice(id, { orgId: A1.id, siteId: siteA1.id, name: 'Uređaj A1' });
  const devA2 = await mkDevice(id, { orgId: A2.id, siteId: siteA2.id, name: 'Uređaj A2', lastSeenAt: new Date(Date.now() - 3 * 3600_000) });
  const devB1 = await mkDevice(id, { orgId: B1.id, name: 'Uređaj B1', batteryLevel: 5 });
  const pending = await mkDevice(id, { name: 'Novi terminal', status: 'PENDING', enrollCode: '654321', lastSeenAt: new Date() });
  const owner = await mkUser(id, 'ADMIN', null);
  const distA = await mkUser(id, 'DISTRIBUTOR', A.id);
  const clientA1 = await mkUser(id, 'CLIENT', A1.id);
  return {
    companyId: id,
    orgs: { A, B, A1, A2, B1 },
    sites: { siteA1, siteA2 },
    devices: { devA1, devA2, devB1, pending },
    users: { owner, distA, clientA1 },
    scope: { owner: await scopeFor(owner), distA: await scopeFor(distA), clientA1: await scopeFor(clientA1) },
  };
}

before(async () => {
  await db.$connect();
});

after(async () => {
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    await db.mdmDevice.deleteMany({ where: { companyId: id } });
    await db.mdmOrg.deleteMany({ where: { companyId: id, parentId: { not: null } } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();

test('opseg: vlasnik vidi sve, distributer svoje klijente, klijent samo sebe', async () => {
  const s = await setup();
  const f = parseDeviceFilters({});
  assert.deepEqual(names((await listDevices(s.scope.owner, f, PAGE)).rows), ['Novi terminal', 'Uređaj A1', 'Uređaj A2', 'Uređaj B1']);
  assert.deepEqual(names((await listDevices(s.scope.distA, f, PAGE)).rows), ['Uređaj A1', 'Uređaj A2']);
  assert.deepEqual(names((await listDevices(s.scope.clientA1, f, PAGE)).rows), ['Uređaj A1']);

  // uređaj po id-u iz URL-a
  assert.ok(await getDevice(s.scope.distA, s.devices.devA2.id));
  assert.equal(await getDevice(s.scope.distA, s.devices.devB1.id), null, 'distributer ne otvara uređaj drugog distributera');
  assert.equal(await getDevice(s.scope.distA, s.devices.pending.id), null, 'uređaj na čekanju vidi samo vlasnik');
  assert.equal(await getDevice(s.scope.clientA1, s.devices.devA2.id), null, 'klijent ne otvara uređaj drugog klijenta istog distributera');

  // organizacije po id-u iz URL-a (regresija: orgWhere ne smije pregaziti traženi id)
  assert.equal(await getOrg(s.scope.distA, s.orgs.B.id), null);
  assert.equal(await getOrg(s.scope.distA, s.orgs.B1.id), null);
  assert.equal((await getOrg(s.scope.distA, s.orgs.A2.id))?.id, s.orgs.A2.id);
  assert.equal(await getOrg(s.scope.clientA1, s.orgs.A.id), null);
  assert.deepEqual((await orgOptions(s.scope.distA)).map((o) => o.label).sort(), ['Distributer A', 'Distributer A › Klijent A1', 'Distributer A › Klijent A2']);

  // nadzorna ploča zbraja samo opseg
  const dash = await mdmDashboard(s.scope.distA);
  assert.equal(dash.enrolled, 2);
  assert.equal(dash.pending, 0);
});

test('filtri u bazi: online/offline, upozorenja, organizacija s klijentima', async () => {
  const s = await setup();
  const q = (sp: Record<string, string>) => listDevices(s.scope.owner, parseDeviceFilters(sp), PAGE).then((r) => names(r.rows));
  assert.deepEqual(await q({ online: 'online' }), ['Uređaj A1', 'Uređaj B1']);
  assert.deepEqual(await q({ online: 'offline' }), ['Uređaj A2']);
  assert.deepEqual(await q({ alert: 'BATTERY' }), ['Uređaj B1']);
  assert.deepEqual(await q({ alert: 'OFFLINE' }), ['Uređaj A2']);
  assert.deepEqual(await q({ alert: 'any' }), ['Uređaj A2', 'Uređaj B1']);
  assert.deepEqual(await q({ org: s.orgs.A.id }), ['Uređaj A1', 'Uređaj A2']);
  assert.deepEqual(await q({ status: 'PENDING' }), ['Novi terminal']);
  assert.deepEqual(await q({ q: '654321' }), ['Novi terminal']);
  // filtar po tuđoj organizaciji ne proširuje opseg
  assert.deepEqual(names((await listDevices(s.scope.clientA1, parseDeviceFilters({ org: s.orgs.B.id }), PAGE)).rows), []);
});

test('naredbe i izmjene samo nad uređajima u opsegu', async () => {
  const s = await setup();
  await assert.rejects(transaction((tx) => queueCommands(tx, s.scope.clientA1, [s.devices.devA2.id], 'REBOOT')), /nisu dostupni/);
  const r = await transaction((tx) => queueCommands(tx, s.scope.clientA1, [s.devices.devA1.id], 'REBOOT'));
  assert.equal(r.queued, 1);
  await assert.rejects(transaction((tx) => queueCommands(tx, s.scope.clientA1, [s.devices.devA1.id], 'WIPE')), /nije dopuštena/);
  await assert.rejects(transaction((tx) => updateDevice(tx, s.scope.distA, s.devices.devB1.id, { notes: 'x' })), /nisu dostupni/);
  // klijent (ops) smije bilješke, ne i naziv
  await transaction((tx) => updateDevice(tx, s.scope.clientA1, s.devices.devA1.id, { notes: 'Kod šanka' }));
  await assert.rejects(transaction((tx) => updateDevice(tx, s.scope.clientA1, s.devices.devA1.id, { name: 'X' })), /Nemate pravo/);
  // premještaj: distributer unutar svojih klijenata da, kod drugog distributera ne
  await transaction((tx) => moveDevices(tx, s.scope.distA, [s.devices.devA1.id], s.orgs.A2.id, s.sites.siteA2.id));
  const moved = await db.mdmDevice.findUniqueOrThrow({ where: { id: s.devices.devA1.id } });
  assert.equal(moved.orgId, s.orgs.A2.id);
  assert.equal(moved.configVersion, 1, 'premještaj podiže verziju konfiguracije');
  await assert.rejects(transaction((tx) => moveDevices(tx, s.scope.distA, [s.devices.devA1.id], s.orgs.B1.id, null)), /nije dostupna/);
  await assert.rejects(transaction((tx) => moveDevices(tx, s.scope.distA, [s.devices.devA1.id], s.orgs.A1.id, s.sites.siteA2.id)), /ne pripada/);
  // profil drugog distributera nije vidljiv
  const foreign = await db.mdmProfile.create({ data: { companyId: s.companyId, orgId: s.orgs.B.id, name: 'B profil', platform: 'ANDROID' } });
  await assert.rejects(transaction((tx) => assignProfile(tx, s.scope.distA, [s.devices.devA2.id], foreign.id)), /nije dostupan/);
  const shared = await db.mdmProfile.create({ data: { companyId: s.companyId, orgId: null, name: 'Zajednički', platform: 'WINDOWS' } });
  await assert.rejects(transaction((tx) => assignProfile(tx, s.scope.distA, [s.devices.devA2.id], shared.id)), /je za Windows/);
  // veza na ERP samo vlasnik
  await assert.rejects(transaction((tx) => linkItem(tx, s.scope.distA, s.devices.devA2.id, null)), /samo vlasnik/);
});

test('upis kodom: distributer upisuje uređaj na čekanju u svog klijenta', async () => {
  const s = await setup();
  await assert.rejects(transaction((tx) => enrollByCode(tx, s.scope.distA, { code: '12345', orgId: s.orgs.A1.id, siteId: null, name: null, profileId: null })), /6 znamenki/);
  await assert.rejects(transaction((tx) => enrollByCode(tx, s.scope.distA, { code: '111111', orgId: s.orgs.A1.id, siteId: null, name: null, profileId: null })), /ne čeka upis/);
  await assert.rejects(transaction((tx) => enrollByCode(tx, s.scope.distA, { code: '654321', orgId: s.orgs.B1.id, siteId: null, name: null, profileId: null })), /nije dostupna/);
  await assert.rejects(transaction((tx) => enrollByCode(tx, s.scope.distA, { code: '654321', orgId: s.orgs.A1.id, siteId: s.sites.siteA2.id, name: null, profileId: null })), /ne pripada/);
  await assert.rejects(transaction((tx) => enrollByCode(tx, s.scope.clientA1, { code: '654321', orgId: s.orgs.A1.id, siteId: null, name: null, profileId: null })), /Nemate pravo/);

  const r = await transaction((tx) => enrollByCode(tx, s.scope.distA, { code: ' 654 321 ', orgId: s.orgs.A1.id, siteId: s.sites.siteA1.id, name: 'Blagajna 2', profileId: null }));
  assert.equal(r.id, s.devices.pending.id);
  const d = await db.mdmDevice.findUniqueOrThrow({ where: { id: r.id } });
  assert.equal(d.status, 'ENROLLED');
  assert.equal(d.enrollCode, null);
  assert.equal(d.orgId, s.orgs.A1.id);
  assert.equal(d.siteId, s.sites.siteA1.id);
  assert.equal(d.name, 'Blagajna 2');
  assert.ok(d.enrolledAt);
  assert.equal(d.configVersion, 1);
  assert.equal(await db.mdmEvent.count({ where: { deviceId: d.id, type: 'ENROLLED' } }), 1);
  // isti kod drugi put
  await assert.rejects(transaction((tx) => enrollByCode(tx, s.scope.distA, { code: '654321', orgId: s.orgs.A1.id, siteId: null, name: null, profileId: null })), /ne čeka upis/);
  // sada ga vidi i klijent A1
  assert.ok(await getDevice(s.scope.clientA1, d.id));

  // ključ za upis samo u vlastiti opseg
  await assert.rejects(transaction((tx) => createEnrollToken(tx, s.scope.distA, { orgId: s.orgs.B1.id, siteId: null, label: null, maxUses: null, expiresAt: null })), /nije dostupna/);
  const t = await transaction((tx) => createEnrollToken(tx, s.scope.distA, { orgId: s.orgs.A1.id, siteId: s.sites.siteA1.id, label: 'Test', maxUses: 5, expiresAt: null }));
  assert.match(t.token, /^[0-9a-f]{32}$/);
});

test('organizacije: distributer otvara samo svoje klijente, brisanje s uređajima blokirano', async () => {
  const s = await setup();
  const base = { oib: null, email: null, phone: null, address: null, city: null, note: null, active: true, partnerId: null };
  // distributer pokušava otvoriti distributera pod drugim roditeljem → postaje njegov klijent
  const id = await transaction((tx) => saveOrg(tx, s.scope.distA, null, { ...base, type: 'DISTRIBUTOR', parentId: s.orgs.B.id, name: 'Novi klijent' }));
  const o = await db.mdmOrg.findUniqueOrThrow({ where: { id } });
  assert.equal(o.type, 'CUSTOMER');
  assert.equal(o.parentId, s.orgs.A.id);
  await assert.rejects(transaction((tx) => saveOrg(tx, s.scope.clientA1, null, { ...base, type: 'CUSTOMER', parentId: null, name: 'X d.o.o.' })), /Nemate pravo|distributer ili vlasnik/);
  await assert.rejects(transaction((tx) => saveOrg(tx, s.scope.distA, s.orgs.B1.id, { ...base, type: 'CUSTOMER', parentId: null, name: 'Preuzimanje' })), /nije dostupna/);
  // vlastitu organizaciju distributer ne može deaktivirati
  await transaction((tx) => saveOrg(tx, s.scope.distA, s.orgs.A.id, { ...base, active: false, type: 'DISTRIBUTOR', parentId: null, name: 'Distributer A' }));
  assert.equal((await db.mdmOrg.findUniqueOrThrow({ where: { id: s.orgs.A.id } })).active, true);

  await assert.rejects(transaction((tx) => deleteOrg(tx, s.scope.owner, s.orgs.A1.id)), /uređaja/);
  await assert.rejects(transaction((tx) => deleteOrg(tx, s.scope.owner, s.orgs.B.id)), /klijenata/);
  await assert.rejects(transaction((tx) => deleteOrg(tx, s.scope.distA, s.orgs.A.id)), /Vlastitu organizaciju/);
  // opseg se računa po zahtjevu — novi klijent je u njemu od sljedećeg zahtjeva
  const fresh = await scopeFor(s.users.distA);
  await transaction((tx) => saveSite(tx, fresh, null, { orgId: id, name: 'Lokal', address: null, timezone: 'Europe/Zagreb', profileId: null, note: null }));
  await assert.rejects(transaction((tx) => saveSite(tx, fresh, null, { orgId: id, name: 'Lokal 2', address: null, timezone: 'Mars/Olympus', profileId: null, note: null })), /vremenska zona/);
  await transaction((tx) => deleteOrg(tx, fresh, id));
  assert.equal(await db.mdmOrg.count({ where: { id } }), 0);
});

test('vanjski korisnici: uloga prema organizaciji, prava ne rastu, deaktivacija odjavljuje', async () => {
  const s = await setup();
  const input = { name: 'Ivo Klijent', password: 'tajna1234', active: true, level: null };
  const uid = await transaction((tx) => saveMdmUser(tx, s.scope.distA, null, { ...input, orgId: s.orgs.A1.id, email: `ivo${Date.now()}@t.hr` }));
  const u = await db.user.findUniqueOrThrow({ where: { id: uid } });
  assert.equal(u.role, 'CLIENT');
  assert.equal(u.mdmOrgId, s.orgs.A1.id);
  const did = await transaction((tx) => saveMdmUser(tx, s.scope.owner, null, { ...input, orgId: s.orgs.B.id, email: `b${Date.now()}@t.hr` }));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: did } })).role, 'DISTRIBUTOR');
  await assert.rejects(transaction((tx) => saveMdmUser(tx, s.scope.distA, null, { ...input, orgId: s.orgs.B1.id, email: `x${Date.now()}@t.hr` })), /nije dostupna/);
  await assert.rejects(transaction((tx) => saveMdmUser(tx, s.scope.clientA1, null, { ...input, orgId: s.orgs.A1.id, email: `y${Date.now()}@t.hr` })), /Nemate pravo|distributer/);
  await assert.rejects(transaction((tx) => saveMdmUser(tx, s.scope.distA, null, { ...input, password: 'kratka', orgId: s.orgs.A1.id, email: `z${Date.now()}@t.hr` })), /barem 8/);
  // distributer ne uređuje korisnike drugog distributera ni ERP korisnike
  await assert.rejects(transaction((tx) => setMdmUserActive(tx, s.scope.distA, did, false)), /nije dostupan/);
  await assert.rejects(transaction((tx) => setMdmUserActive(tx, s.scope.owner, s.users.owner.id, false)), /nije dostupan/);
  // deaktivacija odjavljuje
  await db.session.create({ data: { userId: uid, tokenHash: randomBytes(16).toString('hex'), expiresAt: new Date(Date.now() + 3600_000) } });
  await transaction((tx) => setMdmUserActive(tx, s.scope.distA, uid, false));
  assert.equal(await db.session.count({ where: { userId: uid, revokedAt: null } }), 0);
});
