/**
 * MDM konfiguracije nad pravom bazom (wms_test).  npm run test:db
 * Spremanje profila podiže verziju konfiguracije uređaja na dodijeljenim lokacijama,
 * zajednički profil mijenja samo vlasnik, izmjene uređaja čuvaju samo razliku.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { MdmScope } from '../../src/server/mdm/scope';
import { buildEffectiveConfig } from '../../src/server/mdm/config';
import { assignSites, deleteProfile, duplicateProfile, saveDeviceOverrides, saveProfile, setDeviceProfile, zConfig, zSettings, type ProfileInput } from '../../src/server/mdm/profiles';
import { addAppVersion, deleteVersion } from '../../src/server/mdm/apps';
import { uploadOrg } from '../../src/server/mdm/files';
import type { ProfileSettings } from '../../src/domain/mdm';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup() {
  const c = await db.company.create({ data: { name: `MDM ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `mdm${Date.now()}${Math.random()}@t.hr`, name: 'Vlasnik', passwordHash: 'x', role: 'ADMIN' } });
  const actor = { id: u.id, name: u.name, companyId: c.id };
  const dist = await db.mdmOrg.create({ data: { companyId: c.id, type: 'DISTRIBUTOR', name: 'Distributer' } });
  const client = await db.mdmOrg.create({ data: { companyId: c.id, type: 'CUSTOMER', name: 'Klijent', parentId: dist.id } });
  const other = await db.mdmOrg.create({ data: { companyId: c.id, type: 'CUSTOMER', name: 'Drugi klijent' } });
  const site = await db.mdmSite.create({ data: { orgId: client.id, name: 'Restoran' } });
  const site2 = await db.mdmSite.create({ data: { orgId: client.id, name: 'Terasa' } });
  let n = 0;
  const dev = (siteId: string, platform: 'ANDROID' | 'WINDOWS' = 'ANDROID', orgId = client.id) =>
    db.mdmDevice.create({ data: { companyId: c.id, orgId, siteId, platform, status: 'ENROLLED', name: `D${++n}`, tokenHash: `t-${c.id}-${n}` } });
  const devices = { a: await dev(site.id), b: await dev(site.id), elsewhere: await dev(site2.id) };
  const base = { companyId: c.id, userName: 'Tester', userId: u.id };
  const owner: MdmScope = { ...base, owner: true, orgIds: null, homeOrgId: null, level: 'edit' };
  const clientScope: MdmScope = { ...base, owner: false, orgIds: [client.id], homeOrgId: client.id, level: 'edit' };
  const distScope: MdmScope = { ...base, owner: false, orgIds: [dist.id, client.id], homeOrgId: dist.id, level: 'edit' };
  return { companyId: c.id, actor, dist, client, other, site, site2, devices, owner, clientScope, distScope };
}

const input = (p: Omit<Partial<ProfileInput>, 'settings'> & { settings?: Record<string, unknown> }): ProfileInput => ({
  id: null,
  name: 'Konobari',
  platform: 'ANDROID',
  orgId: null,
  note: null,
  ...p,
  settings: zSettings.parse(p.settings ?? {}),
  apps: p.apps ?? [],
});

const version = async (id: string) => (await db.mdmDevice.findUniqueOrThrow({ where: { id } })).configVersion;

before(async () => {
  await db.$connect();
});

after(async () => {
  for (const id of companies) {
    await db.mdmDevice.deleteMany({ where: { companyId: id } });
    await db.mdmAppVersion.deleteMany({ where: { app: { companyId: id } } });
    await db.mdmApp.deleteMany({ where: { companyId: id } });
    await db.mdmFile.deleteMany({ where: { companyId: id } });
    await db.mdmProfile.deleteMany({ where: { companyId: id } });
    await db.mdmOrg.deleteMany({ where: { companyId: id, parentId: { not: null } } });
    await db.mdmOrg.deleteMany({ where: { companyId: id } });
    await db.user.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

test('spremanje profila podiže verziju konfiguracije uređaja na dodijeljenim lokacijama', async () => {
  const s = await setup();
  const p = await transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ settings: { kiosk: true } })));
  assert.equal(p.affected, 0, 'novi profil još nije nigdje dodijeljen');

  const a0 = await version(s.devices.a.id);
  const e0 = await version(s.devices.elsewhere.id);
  const r = await transaction((tx) => assignSites(tx, s.owner, s.actor, p.id, [s.site.id]));
  assert.deepEqual([r.added, r.removed, r.affected], [1, 0, 2]);
  assert.equal(await version(s.devices.a.id), a0 + 1);

  const saved = await transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ id: p.id, settings: { kiosk: true, volumePct: 40 } })));
  assert.equal(saved.version, 2);
  assert.equal(saved.affected, 2);
  assert.equal(await version(s.devices.a.id), a0 + 2);
  assert.equal(await version(s.devices.b.id), a0 + 2);
  assert.equal(await version(s.devices.elsewhere.id), e0, 'uređaj na drugoj lokaciji se ne dira');

  // uređaj s vlastitim profilom ne prati profil lokacije
  const own = await transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ name: 'Vlastiti' })));
  await transaction((tx) => setDeviceProfile(tx, s.owner, s.actor, s.devices.b.id, own.id));
  const b1 = await version(s.devices.b.id);
  await transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ id: p.id, settings: { kiosk: false } })));
  assert.equal(await version(s.devices.b.id), b1);

  const cfg = await buildEffectiveConfig(db, await db.mdmDevice.findUniqueOrThrow({ where: { id: s.devices.a.id } }));
  assert.equal(cfg.settings.kiosk, undefined);

  // dodijeljen profil se ne briše; nakon uklanjanja s lokacije može
  await assert.rejects(transaction((tx) => deleteProfile(tx, s.owner, s.actor, p.id)), /dodijeljena/);
  await transaction((tx) => assignSites(tx, s.owner, s.actor, p.id, []));
  await transaction((tx) => deleteProfile(tx, s.owner, s.actor, p.id));
});

test('klijent ne mijenja zajednički profil; svoj može', async () => {
  const s = await setup();
  const shared = await transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ name: 'Zajednički' })));
  await assert.rejects(transaction((tx) => saveProfile(tx, s.clientScope, s.actor, input({ id: shared.id, name: 'Hakirano' }))), /samo vlasnik/);
  await assert.rejects(transaction((tx) => deleteProfile(tx, s.clientScope, s.actor, shared.id)), /samo vlasnik/);
  await assert.rejects(transaction((tx) => saveProfile(tx, s.clientScope, s.actor, input({ name: 'Novi zajednički' }))), /samo vlasnik/);
  await assert.rejects(transaction((tx) => saveProfile(tx, s.clientScope, s.actor, input({ orgId: s.other.id }))), /nije dostupna/);
  assert.equal((await db.mdmProfile.findUniqueOrThrow({ where: { id: shared.id } })).name, 'Zajednički');

  // koristiti ga smije: dodjela vlastitoj lokaciji i kopija u svoju organizaciju
  await transaction((tx) => assignSites(tx, s.clientScope, s.actor, shared.id, [s.site.id]));
  const copy = await transaction((tx) => duplicateProfile(tx, s.clientScope, s.actor, shared.id));
  assert.equal((await db.mdmProfile.findUniqueOrThrow({ where: { id: copy.id } })).orgId, s.client.id);

  const mine = await transaction((tx) => saveProfile(tx, s.clientScope, s.actor, input({ name: 'Moj', orgId: s.client.id })));
  await transaction((tx) => saveProfile(tx, s.clientScope, s.actor, input({ id: mine.id, name: 'Moj 2' })));
  // profil klijenta ne vidi drugi klijent / nije dostupan izvan opsega
  const otherScope: MdmScope = { ...s.clientScope, orgIds: [s.other.id], homeOrgId: s.other.id };
  await assert.rejects(transaction((tx) => saveProfile(tx, otherScope, s.actor, input({ id: mine.id }))), /nije dostupna/);
  // distributer smije mijenjati profil svog klijenta
  await transaction((tx) => saveProfile(tx, s.distScope, s.actor, input({ id: mine.id, name: 'Moj 3' })));
});

test('opseg: odabrana organizacija je upravo ona zatražena (id se ne gubi u uvjetu opsega)', async () => {
  const s = await setup();
  // distributer ima dvije organizacije u opsegu — rezultat mora biti zatražena, ne prva u opsegu
  assert.equal(await transaction((tx) => uploadOrg(tx, s.distScope, s.client.id)), s.client.id);
  assert.equal(await transaction((tx) => uploadOrg(tx, s.distScope, s.dist.id)), s.dist.id);
  assert.equal(await transaction((tx) => uploadOrg(tx, s.distScope, null)), s.dist.id);
  assert.equal(await transaction((tx) => uploadOrg(tx, s.owner, null)), null);
  await assert.rejects(transaction((tx) => uploadOrg(tx, s.clientScope, s.dist.id)), /nije dostupna/);
  await assert.rejects(transaction((tx) => uploadOrg(tx, s.distScope, s.other.id)), /nije dostupna/);
  // nepostojeća organizacija u opsegu vlasnika (orgIds null) se ne prihvaća
  await assert.rejects(transaction((tx) => uploadOrg(tx, s.owner, 'nepostoji')), /nije dostupna/);
  const p = await transaction((tx) => saveProfile(tx, s.distScope, s.actor, input({ orgId: s.client.id })));
  assert.equal((await db.mdmProfile.findUniqueOrThrow({ where: { id: p.id } })).orgId, s.client.id);
  await assert.rejects(transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ orgId: 'nepostoji' }))), /nije dostupna/);
});

test('Wi-Fi lozinka se zadržava kad se ne upiše; izmjene uređaja čuvaju samo razliku', async () => {
  const s = await setup();
  const wifi = [{ ssid: 'Lokal', security: 'WPA2', password: 'tajna1234' }];
  const p = await transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ settings: { wifi, volumePct: 50 } })));
  await transaction((tx) => assignSites(tx, s.owner, s.actor, p.id, [s.site.id]));
  // bez lozinke (preglednik je nikad ne dobiva) i s promjenom naziva mreže
  await transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ id: p.id, settings: { wifi: [{ ssid: 'Lokal-5G', security: 'WPA2', password: '', origSsid: 'Lokal' }], volumePct: 50 } })));
  const saved = (await db.mdmProfile.findUniqueOrThrow({ where: { id: p.id } })).settings as ProfileSettings;
  assert.deepEqual(saved.wifi, [{ ssid: 'Lokal-5G', security: 'WPA2', password: 'tajna1234' }]);
  await assert.rejects(transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ id: p.id, settings: { wifi: [{ ssid: 'Nova', security: 'WPA2' }] } }))), /upišite lozinku/);

  const edited = zConfig.parse({ settings: { wifi: [{ ssid: 'Lokal-5G', security: 'WPA2', password: '', origSsid: 'Lokal-5G' }], volumePct: 80 }, apps: [] });
  const ov = await transaction((tx) => saveDeviceOverrides(tx, s.owner, s.actor, s.devices.a.id, edited));
  assert.deepEqual(ov, { settings: { volumePct: 80 } });
  const cfg = await buildEffectiveConfig(db, await db.mdmDevice.findUniqueOrThrow({ where: { id: s.devices.a.id } }));
  assert.equal(cfg.settings.volumePct, 80);
  assert.equal(cfg.settings.wifi?.[0].password, 'tajna1234');

  // isključena zabrana na uređaju mora biti izričito false
  await transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ id: p.id, settings: { restrictions: { noCamera: true }, wifi: [{ ssid: 'Lokal-5G', security: 'WPA2', origSsid: 'Lokal-5G' }], volumePct: 50 } })));
  const ov2 = await transaction((tx) =>
    saveDeviceOverrides(tx, s.owner, s.actor, s.devices.a.id, zConfig.parse({ settings: { restrictions: { noCamera: false }, wifi: [{ ssid: 'Lokal-5G', security: 'WPA2', origSsid: 'Lokal-5G' }], volumePct: 50 }, apps: [] })),
  );
  assert.deepEqual(ov2, { settings: { restrictions: { noCamera: false } } });
});

test('aplikacije: verzija u konfiguraciji se ne briše; klijent ne dobiva tuđu aplikaciju', async () => {
  const s = await setup();
  const file = (name: string) => db.mdmFile.create({ data: { companyId: s.companyId, kind: 'APP', name, mime: 'application/vnd.android.package-archive', size: 1, sha256: 'x', storageKey: `aa/${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}` } });
  const f1 = await file('a1.apk');
  const v1 = await transaction((tx) => addAppVersion(tx, s.owner, s.actor, { appId: null, platform: 'ANDROID', orgId: null, packageName: 'hr.test.pos', name: 'POS', version: '1.0', versionCode: 1, installArgs: null, notes: null, fileId: f1.id }));
  const f2 = await file('a2.apk');
  const v2 = await transaction((tx) => addAppVersion(tx, s.owner, s.actor, { appId: null, platform: 'ANDROID', orgId: null, packageName: 'hr.test.pos', name: 'POS', version: '2.0', versionCode: 2, installArgs: null, notes: null, fileId: f2.id }));
  assert.equal(v1.appId, v2.appId, 'isti paket = ista aplikacija');
  await assert.rejects(
    transaction((tx) => addAppVersion(tx, s.owner, s.actor, { appId: null, platform: 'ANDROID', orgId: null, packageName: 'hr.test.pos', name: 'POS', version: '2.0', versionCode: 2, installArgs: null, notes: null, fileId: f2.id })),
    /već postoji/,
  );
  const p = await transaction((tx) =>
    saveProfile(tx, s.owner, s.actor, input({ apps: [{ appId: v1.appId, versionId: v1.versionId, config: { host: '10.0.0.1', port: '24998' }, hidden: false, autoStart: true, remove: false }] })),
  );
  await assert.rejects(transaction((tx) => deleteVersion(tx, s.owner, s.actor, v1.versionId)), /koriste/);
  await transaction((tx) => deleteVersion(tx, s.owner, s.actor, v2.versionId));

  await transaction((tx) => assignSites(tx, s.owner, s.actor, p.id, [s.site.id]));
  const cfg = await buildEffectiveConfig(db, await db.mdmDevice.findUniqueOrThrow({ where: { id: s.devices.a.id } }));
  assert.equal(cfg.settings.startApp, 'hr.test.pos');
  assert.equal(cfg.apps[0].version, '1.0');
  assert.deepEqual(cfg.apps[0].config, { host: '10.0.0.1', port: '24998' });

  // aplikacija drugog klijenta nije dostupna u profilu ovog klijenta
  const f3 = await file('x.apk');
  const foreign = await transaction((tx) => addAppVersion(tx, s.owner, s.actor, { appId: null, platform: 'ANDROID', orgId: s.other.id, packageName: 'hr.drugi.app', name: 'Tuđa', version: '1', versionCode: 1, installArgs: null, notes: null, fileId: f3.id }));
  await assert.rejects(
    transaction((tx) => saveProfile(tx, s.clientScope, s.actor, input({ orgId: s.client.id, apps: [{ appId: foreign.appId, versionId: null, config: {}, hidden: false, autoStart: false, remove: false }] }))),
    /nije dostupna/,
  );
  // dvije aplikacije za pokretanje nisu dopuštene
  await assert.rejects(
    transaction((tx) =>
      saveProfile(tx, s.owner, s.actor, input({ apps: [v1.appId, foreign.appId].map((appId) => ({ appId, versionId: null, config: {}, hidden: false, autoStart: true, remove: false })) })),
    ),
    /Samo jedna/,
  );
});

test('profil lokacije vrijedi samo za uređaje iste platforme', async () => {
  const s = await setup();
  const win = await db.mdmDevice.create({ data: { companyId: s.companyId, orgId: s.client.id, siteId: s.site.id, platform: 'WINDOWS', status: 'ENROLLED', name: 'Blagajna', tokenHash: `t-${s.companyId}-win` } });
  const p = await transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ settings: { kiosk: true } })));
  const w0 = await version(win.id);
  const a0 = await version(s.devices.a.id);
  await transaction((tx) => assignSites(tx, s.owner, s.actor, p.id, [s.site.id]));
  await transaction((tx) => saveProfile(tx, s.owner, s.actor, input({ id: p.id, settings: { kiosk: true, volumePct: 30 } })));
  assert.equal(await version(s.devices.a.id), a0 + 2);
  assert.equal(await version(win.id), w0, 'Android profil ne mijenja verziju Windows uređaja');
  const cfg = await buildEffectiveConfig(db, await db.mdmDevice.findUniqueOrThrow({ where: { id: win.id } }));
  assert.equal(cfg.settings.kiosk, undefined, 'Windows uređaj ne dobiva postavke Android profila');
});
