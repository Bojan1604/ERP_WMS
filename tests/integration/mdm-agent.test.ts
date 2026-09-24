/**
 * API agenta MDM-a nad pravom (testnom) bazom: rukovatelji ruta pozivaju se izravno
 * s Request objektima, kao što bi ih pozvao Next.js.
 *   npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db, transaction } from '../../src/server/db';
import type { MdmScope } from '../../src/server/mdm/scope';
import type { AgentCheckinResponse, AgentRegisterResponse, CommandType } from '../../src/domain/mdm';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

let storageDir = '';
const companies: string[] = [];
// rukovatelji se učitavaju tek nakon što je postavljen MDM_STORAGE_DIR (storage.ts ga čita pri učitavanju)
let R: {
  register: typeof import('../../src/app/api/mdm/agent/register/route');
  checkin: typeof import('../../src/app/api/mdm/agent/checkin/route');
  result: typeof import('../../src/app/api/mdm/agent/commands/[id]/route');
  upload: typeof import('../../src/app/api/mdm/agent/upload/route');
  files: typeof import('../../src/app/api/mdm/agent/files/[id]/route');
  download: typeof import('../../src/app/api/mdm/agent/download/[artifact]/route');
  storage: typeof import('../../src/server/mdm/storage');
  commands: typeof import('../../src/server/mdm/commands');
  agent: typeof import('../../src/server/mdm/agent');
};

before(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'mdm-agent-test-'));
  process.env.MDM_STORAGE_DIR = storageDir;
  process.env.MDM_AGENT_DIR = path.join(storageDir, 'agents');
  R = {
    register: await import('../../src/app/api/mdm/agent/register/route'),
    checkin: await import('../../src/app/api/mdm/agent/checkin/route'),
    result: await import('../../src/app/api/mdm/agent/commands/[id]/route'),
    upload: await import('../../src/app/api/mdm/agent/upload/route'),
    files: await import('../../src/app/api/mdm/agent/files/[id]/route'),
    download: await import('../../src/app/api/mdm/agent/download/[artifact]/route'),
    storage: await import('../../src/server/mdm/storage'),
    commands: await import('../../src/server/mdm/commands'),
    agent: await import('../../src/server/mdm/agent'),
  };
  await db.$connect();
});

after(async () => {
  for (const id of companies) await db.company.delete({ where: { id } }).catch(() => {});
  await db.$disconnect();
  await rm(storageDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- pomoćnici

let ipSeq = 1;
const nextIp = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

function req(p: string, o: { method?: string; token?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; ip?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? nextIp(), ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Device ${o.token}`;
  let body = o.body;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers['content-type'] = 'application/json';
  }
  return new Request(`http://localhost:3100/api/mdm/agent${p}`, { method: o.method ?? 'POST', headers, body, ...(body ? { duplex: 'half' } : {}) } as RequestInit);
}

async function register(body: Record<string, unknown>, ip?: string) {
  const res = await R.register.POST(req('/register', { json: { protocol: 1, platform: 'ANDROID', ...body }, ip }));
  return { status: res.status, body: (await res.json()) as AgentRegisterResponse & { code?: string } };
}

async function checkin(token: string, body: Record<string, unknown> = {}) {
  const res = await R.checkin.POST(req('/checkin', { token, json: { telemetry: {}, ...body } }));
  return { status: res.status, body: (await res.json()) as AgentCheckinResponse & { code?: string } };
}

async function postResult(token: string, id: string, body: Record<string, unknown>) {
  const res = await R.result.POST(req(`/commands/${id}`, { token, json: body }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const getFile = (token: string, id: string, headers: Record<string, string> = {}, method = 'GET') =>
  R.files.GET(req(`/files/${id}`, { method, token, headers }), { params: Promise.resolve({ id }) });

const upload = (token: string, qs: string, body: Buffer, headers: Record<string, string> = {}) =>
  R.upload.POST(req(`/upload?${qs}`, { token, body: new Uint8Array(body), headers: { 'content-type': 'application/octet-stream', ...headers } }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function setup() {
  const c = await db.company.create({ data: { name: `MDM agent test ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  process.env.MDM_DEFAULT_COMPANY_ID = c.id;
  const org = await db.mdmOrg.create({ data: { companyId: c.id, type: 'CUSTOMER', name: 'Kafić Test' } });
  const apk = await R.storage.saveBuffer(Buffer.from('fake apk '.repeat(1000)));
  const file = await db.mdmFile.create({ data: { companyId: c.id, orgId: null, kind: 'APP', name: 'pos.apk', mime: 'application/vnd.android.package-archive', size: apk.size, sha256: apk.sha256, storageKey: apk.key } });
  const app = await db.mdmApp.create({ data: { companyId: c.id, platform: 'ANDROID', name: 'POS', packageName: 'hr.test.pos' } });
  const ver = await db.mdmAppVersion.create({ data: { appId: app.id, version: '1.2.0', versionCode: 120, fileId: file.id } });
  const other = await R.storage.saveBuffer(Buffer.from('some other file'));
  const otherFile = await db.mdmFile.create({ data: { companyId: c.id, kind: 'FILE', name: 'cjenik.csv', mime: 'text/csv', size: other.size, sha256: other.sha256, storageKey: other.key } });
  const profile = await db.mdmProfile.create({
    data: { companyId: c.id, name: 'Blagajne', platform: 'ANDROID', settings: { kiosk: true, startApp: app.id }, apps: [{ appId: app.id, autoStart: true }] },
  });
  const site = await db.mdmSite.create({ data: { orgId: org.id, name: 'Lokal 1', profileId: profile.id } });
  const scope: MdmScope = { companyId: c.id, owner: true, orgIds: null, homeOrgId: null, level: 'edit', userName: 'Tester', userId: 'u' };
  return { companyId: c.id, org, site, app, ver, file, otherFile, profile, scope };
}

type S = Awaited<ReturnType<typeof setup>>;

async function enrollToken(s: S, extra: { maxUses?: number; expiresAt?: Date } = {}) {
  const token = `tok_${Math.random().toString(36).slice(2)}${Date.now()}`;
  await db.mdmEnrollToken.create({ data: { companyId: s.companyId, orgId: s.org.id, siteId: s.site.id, token, label: 'Test QR', ...extra } });
  return token;
}

/** Upis kodom kao u portalu: organizacija, lokacija, podignuta verzija konfiguracije. */
async function portalEnroll(s: S, deviceId: string) {
  await db.mdmDevice.update({
    where: { id: deviceId },
    data: { status: 'ENROLLED', orgId: s.org.id, siteId: s.site.id, enrollCode: null, enrolledAt: new Date(), configVersion: { increment: 1 } },
  });
}

const queue = (s: S, ids: string[], type: CommandType, payload: Record<string, unknown> = {}) =>
  transaction((tx) => R.commands.queueCommands(tx, s.scope, ids, type, payload as never));

// ---------------------------------------------------------------- testovi

test('registracija bez ključa → PENDING s kodom; bez naredbi i konfiguracije do upisa', async () => {
  const s = await setup();
  const r = await register({ hardwareId: 'hw-pending-1', manufacturer: 'SUNMI', model: 'V2s', agentVersion: '1.0.0' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'PENDING');
  assert.match(r.body.enrollCode ?? '', /^\d{6}$/);
  assert.match(r.body.token, /^[A-Za-z0-9_-]{43}$/);
  const d = await db.mdmDevice.findUniqueOrThrow({ where: { id: r.body.deviceId } });
  assert.equal(d.companyId, s.companyId);
  assert.equal(d.tokenHash, createHash('sha256').update(r.body.token).digest('hex'), 'u bazi je samo sažetak tokena');
  assert.equal(d.name, 'SUNMI V2s');

  // naredba ubačena mimo portala ne smije stići uređaju koji čeka upis
  await db.mdmCommand.create({ data: { deviceId: d.id, type: 'REBOOT' } });
  const c = await checkin(r.body.token, { telemetry: { batteryLevel: 150, wifiSignal: 20, model: 'x'.repeat(500), storageFreeMb: 'bad' } });
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'PENDING');
  assert.equal(c.body.enrollCode, r.body.enrollCode);
  assert.deepEqual(c.body.commands, []);
  assert.equal(c.body.config, null);
  const after1 = await db.mdmDevice.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(after1.batteryLevel, 100, 'ograničeno na 100');
  assert.equal(after1.wifiSignal, 0);
  assert.equal(after1.model?.length, 100);
  assert.ok(after1.lastSeenAt);
  assert.ok(after1.publicIp?.startsWith('10.77.'));

  // ponovna registracija istog uređaja koristi isti redak, stari ključ prestaje vrijediti
  const again = await register({ hardwareId: 'hw-pending-1' });
  assert.equal(again.body.deviceId, r.body.deviceId);
  assert.notEqual(again.body.token, r.body.token);
  assert.equal((await checkin(r.body.token)).status, 401);
  assert.equal((await checkin(again.body.token)).status, 200);
  assert.equal(await db.mdmCommand.count({ where: { deviceId: d.id, status: 'CANCELLED' } }), 1, 'naredbe stare instalacije otkazane');
});

test('upis → konfiguracija i naredbe točno jednom, i pri istovremenim javljanjima', async () => {
  const s = await setup();
  const r = await register({ hardwareId: 'hw-conc-1' });
  await portalEnroll(s, r.body.deviceId);

  const first = await checkin(r.body.token, { appliedConfigVersion: 0 });
  assert.equal(first.body.status, 'ENROLLED');
  assert.equal(first.body.enrollCode, null);
  assert.ok(first.body.config, 'nova konfiguracija');
  const cfg = first.body.config!;
  assert.equal(cfg.settings.kiosk, true);
  assert.equal(cfg.settings.startApp, 'hr.test.pos', 'appId razriješen u paket');
  assert.equal(cfg.apps[0].downloadPath, `/api/mdm/agent/files/${s.file.id}`);
  assert.equal(cfg.apps[0].sha256, s.file.sha256);

  // primijenjena verzija → nema više konfiguracije, događaj CONFIG_APPLIED
  const second = await checkin(r.body.token, { appliedConfigVersion: cfg.version });
  assert.equal(second.body.config, null);
  assert.equal(await db.mdmEvent.count({ where: { deviceId: r.body.deviceId, type: 'CONFIG_APPLIED' } }), 1);

  for (let i = 0; i < 45; i++) await queue(s, [r.body.deviceId], 'MESSAGE', { text: `poruka ${i}` });
  const results = await Promise.all(Array.from({ length: 10 }, () => checkin(r.body.token, { appliedConfigVersion: cfg.version })));
  const ids = results.flatMap((x) => x.body.commands.map((c) => c.id));
  assert.ok(results.every((x) => x.status === 200));
  assert.ok(results.every((x) => x.body.commands.length <= 20));
  assert.equal(ids.length, 45, 'sve naredbe isporučene');
  assert.equal(new Set(ids).size, 45, 'nijedna dvaput');
  const more = await checkin(r.body.token, { appliedConfigVersion: cfg.version });
  assert.equal(more.body.commands.length, 0);
  // redoslijed: najstarije prve unutar jednog odgovora
  for (const x of results) {
    const nums = x.body.commands.map((c) => Number(String(c.payload.text).split(' ')[1]));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
  }

  // agent se srušio: poslana naredba bez rezultata nakon 10 min stiže ponovno
  await db.mdmCommand.update({ where: { id: ids[0] }, data: { sentAt: new Date(Date.now() - 11 * 60_000) } });
  const re = await checkin(r.body.token, { appliedConfigVersion: cfg.version });
  assert.deepEqual(re.body.commands.map((c) => c.id), [ids[0]]);

  // istekla naredba se ne isporučuje
  await queue(s, [r.body.deviceId], 'LOCK');
  await db.mdmCommand.updateMany({ where: { deviceId: r.body.deviceId, type: 'LOCK' }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await checkin(r.body.token, { appliedConfigVersion: cfg.version })).body.commands.length, 0);
  assert.equal((await db.mdmCommand.findFirstOrThrow({ where: { deviceId: r.body.deviceId, type: 'LOCK' } })).status, 'EXPIRED');

  // APPLY_CONFIG uvijek donosi konfiguraciju
  await queue(s, [r.body.deviceId], 'APPLY_CONFIG');
  const ap = await checkin(r.body.token, { appliedConfigVersion: cfg.version });
  assert.equal(ap.body.commands[0].type, 'APPLY_CONFIG');
  assert.ok(ap.body.config);
});

test('telemetrija, aplikacije i događaji', async () => {
  const s = await setup();
  const r = await register({ hardwareId: 'hw-tel-1' });
  await portalEnroll(s, r.body.deviceId);
  const apps = Array.from({ length: 2100 }, (_, i) => ({ packageName: `p.k${i}`, versionCode: i }));
  await checkin(r.body.token, {
    telemetry: { batteryLevel: 50, charging: false, storageFreeMb: 5000, storageTotalMb: 32000, uptimeSec: 5000, agentVersion: '1.0.0', apps, extra: { patch: '2026-01' } },
    events: Array.from({ length: 60 }, (_, i) => ({ type: 'TEST', message: `e${i}`, level: i % 2 ? 'warn' : 'nonsense' })),
  });
  let d = await db.mdmDevice.findUniqueOrThrow({ where: { id: r.body.deviceId } });
  const tel = d.telemetry as { apps: unknown[]; extra: Record<string, unknown> };
  assert.equal(tel.apps.length, 2000);
  assert.equal(tel.extra.patch, '2026-01');
  assert.equal(await db.mdmEvent.count({ where: { deviceId: d.id, type: 'TEST' } }), 50);
  assert.equal(await db.mdmEvent.count({ where: { deviceId: d.id, type: 'TEST', level: 'info' } }), 25, 'nepoznata razina → info');

  // bez popisa aplikacija: popis ostaje, extra se mijenja
  await checkin(r.body.token, { telemetry: { batteryLevel: 10, charging: false, storageFreeMb: 1000, uptimeSec: 30, agentVersion: '1.1.0', extra: { patch: '2026-02' } } });
  d = await db.mdmDevice.findUniqueOrThrow({ where: { id: r.body.deviceId } });
  assert.equal((d.telemetry as { apps: unknown[] }).apps.length, 2000);
  assert.equal((d.telemetry as { extra: { patch: string } }).extra.patch, '2026-02');
  const types = (await db.mdmEvent.findMany({ where: { deviceId: d.id }, select: { type: true } })).map((e) => e.type);
  for (const t of ['BATTERY_LOW', 'STORAGE_LOW', 'AGENT_UPDATED', 'BOOT']) assert.ok(types.includes(t), t);

  // povratak nakon duljeg izostanka
  await db.mdmDevice.update({ where: { id: d.id }, data: { lastSeenAt: new Date(Date.now() - 3 * 3600_000) } });
  await checkin(r.body.token);
  const on = await db.mdmDevice.findUniqueOrThrow({ where: { id: d.id } });
  assert.ok(on.onlineSince && Date.now() - on.onlineSince.getTime() < 10_000);
  assert.equal(await db.mdmEvent.count({ where: { deviceId: d.id, type: 'ONLINE' } }), 1);
});

test('rezultat naredbe: samo vlasnik, idempotentno; FORGET odjavljuje, 410 za odjavljen uređaj', async () => {
  const s = await setup();
  const a = await register({ hardwareId: 'hw-res-a' });
  const b = await register({ hardwareId: 'hw-res-b' });
  await portalEnroll(s, a.body.deviceId);
  await portalEnroll(s, b.body.deviceId);
  await queue(s, [a.body.deviceId], 'REBOOT');
  const [cmd] = (await checkin(a.body.token)).body.commands;
  assert.equal(cmd.type, 'REBOOT');

  assert.equal((await postResult(b.body.token, cmd.id, { ok: true })).status, 404, 'tuđa naredba');
  assert.equal((await postResult(a.body.token, cmd.id, { ok: 'yes' })).status, 400);
  const ok = await postResult(a.body.token, cmd.id, { ok: true, result: { x: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'SUCCEEDED');
  assert.equal(ok.body.duplicate, false);
  const dup = await postResult(a.body.token, cmd.id, { ok: false, error: 'kasno' });
  assert.equal(dup.body.duplicate, true);
  assert.equal(dup.body.status, 'SUCCEEDED', 'prvi rezultat ostaje');
  const row = await db.mdmCommand.findUniqueOrThrow({ where: { id: cmd.id } });
  assert.equal(row.status, 'SUCCEEDED');
  assert.ok(row.doneAt);

  // neisporučena naredba → 409
  await queue(s, [a.body.deviceId], 'LOCK');
  const lock = await db.mdmCommand.findFirstOrThrow({ where: { deviceId: a.body.deviceId, type: 'LOCK' } });
  assert.equal((await postResult(a.body.token, lock.id, { ok: true })).status, 409);

  // neuspjeh
  const [l] = (await checkin(a.body.token)).body.commands;
  const f = await postResult(a.body.token, l.id, { ok: false, error: 'Nema zaslona' });
  assert.equal(f.body.status, 'FAILED');
  assert.equal((await db.mdmCommand.findUniqueOrThrow({ where: { id: l.id } })).error, 'Nema zaslona');

  // FORGET
  await queue(s, [a.body.deviceId], 'FORGET');
  await queue(s, [a.body.deviceId], 'SCREENSHOT');
  const delivered = (await checkin(a.body.token)).body.commands;
  const forget = delivered.find((c) => c.type === 'FORGET')!;
  const fr = await postResult(a.body.token, forget.id, { ok: true });
  assert.equal(fr.body.deviceStatus, 'RETIRED');
  const dev = await db.mdmDevice.findUniqueOrThrow({ where: { id: a.body.deviceId } });
  assert.equal(dev.status, 'RETIRED');
  assert.equal(dev.orgId, s.org.id, 'organizacija ostaje radi povijesti');
  assert.equal(await db.mdmCommand.count({ where: { deviceId: dev.id, status: { in: ['PENDING', 'SENT'] } } }), 0);
  assert.equal((await checkin(a.body.token)).status, 401, 'ključ poništen');

  // odjavljen u portalu (ključ ostaje) → 410 { status: RETIRED }
  await db.mdmDevice.update({ where: { id: b.body.deviceId }, data: { status: 'RETIRED' } });
  const gone = await checkin(b.body.token);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.status, 'RETIRED');

  // odjavljen uređaj se ponovnom registracijom vraća kao PENDING (isti redak, bez organizacije)
  const back = await register({ hardwareId: 'hw-res-a' });
  assert.equal(back.body.deviceId, a.body.deviceId);
  assert.equal(back.body.status, 'PENDING');
  assert.equal((await db.mdmDevice.findUniqueOrThrow({ where: { id: a.body.deviceId } })).orgId, null);
});

test('autentikacija ključem uređaja', async () => {
  await setup();
  assert.equal((await R.checkin.POST(req('/checkin', { json: {} }))).status, 401);
  assert.equal((await R.checkin.POST(req('/checkin', { json: {}, headers: { authorization: 'Bearer abc' } }))).status, 401);
  const bad = await R.checkin.POST(req('/checkin', { json: {}, token: 'A'.repeat(43) }));
  assert.equal(bad.status, 401);
  assert.equal(((await bad.json()) as { code: string }).code, 'UNAUTHORIZED');
  const r = await register({ hardwareId: 'hw-auth' });
  const notJson = await R.checkin.POST(req('/checkin', { token: r.body.token, body: '{nope', headers: { 'content-type': 'application/json' } }));
  assert.equal(notJson.status, 400);
  const huge = await R.checkin.POST(req('/checkin', { token: r.body.token, body: 'x'.repeat(3 * 1024 * 1024) }));
  assert.equal(huge.status, 413);
});

test('ključ upisa: izravno ENROLLED, maxUses, istek, protokol, ograničenje po IP-u', async () => {
  const s = await setup();
  const tok = await enrollToken(s, { maxUses: 2 });
  const a = await register({ hardwareId: 'hw-tok-1', enrollToken: tok, name: 'Blagajna 1' });
  assert.equal(a.status, 200);
  assert.equal(a.body.status, 'ENROLLED');
  assert.equal(a.body.enrollCode, null);
  const d = await db.mdmDevice.findUniqueOrThrow({ where: { id: a.body.deviceId } });
  assert.equal(d.orgId, s.org.id);
  assert.equal(d.siteId, s.site.id);
  assert.equal(d.name, 'Blagajna 1');
  const c = await checkin(a.body.token, { appliedConfigVersion: 0 });
  assert.ok(c.body.config, 'konfiguracija lokacije odmah');

  // ponovna instalacija na istom uređaju (isti hardwareId) — isti redak, i dalje upisan
  const again = await register({ hardwareId: 'hw-tok-1', enrollToken: tok });
  assert.equal(again.body.deviceId, a.body.deviceId);
  assert.equal(again.body.status, 'ENROLLED');
  const used = await register({ hardwareId: 'hw-tok-2', enrollToken: tok });
  assert.equal(used.status, 403);
  assert.equal(used.body.code, 'ENROLL_TOKEN_INVALID');
  assert.equal((await db.mdmEnrollToken.findUniqueOrThrow({ where: { token: tok } })).uses, 2);

  const expired = await enrollToken(s, { expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await register({ hardwareId: 'hw-tok-3', enrollToken: expired })).status, 403);
  assert.equal((await register({ hardwareId: 'hw-tok-3', enrollToken: 'nepostojeci' })).status, 403);
  assert.equal((await register({ hardwareId: 'hw-tok-3', protocol: 2 })).body.code, 'PROTOCOL_UNSUPPORTED');
  assert.equal((await register({ hardwareId: '' })).status, 400);

  // istovremena upotreba ključa s maxUses 3 → točno 3 uspjeha
  const t3 = await enrollToken(s, { maxUses: 3 });
  const many = await Promise.all(Array.from({ length: 8 }, (_, i) => register({ hardwareId: `hw-race-${i}`, enrollToken: t3 })));
  assert.equal(many.filter((m) => m.status === 200).length, 3);

  R.agent.registerLimiter.reset();
  const ip = '10.200.0.1';
  const codes: number[] = [];
  for (let i = 0; i < 21; i++) codes.push((await register({ hardwareId: `hw-rl-${i}` }, ip)).status);
  assert.equal(codes.filter((x) => x === 200).length, 20);
  assert.equal(codes[20], 429);
  const pendingCodes = await db.mdmDevice.findMany({ where: { companyId: s.companyId, status: 'PENDING' }, select: { enrollCode: true } });
  assert.equal(new Set(pendingCodes.map((p) => p.enrollCode)).size, pendingCodes.length, 'kodovi jedinstveni');
});

test('slanje snimki i zapisnika: vrsta iz bajtova, ograničenja, zadržavanje 20', async () => {
  const s = await setup();
  const pend = await register({ hardwareId: 'hw-up-p' });
  assert.equal((await upload(pend.body.token, 'kind=SCREENSHOT', PNG)).status, 403, 'uređaj na čekanju');

  const r = await register({ hardwareId: 'hw-up-1', enrollToken: await enrollToken(s) });
  await queue(s, [r.body.deviceId], 'SCREENSHOT');
  const [cmd] = (await checkin(r.body.token)).body.commands;

  assert.equal((await upload(r.body.token, 'kind=OTHER', PNG)).status, 400);
  assert.equal((await upload(r.body.token, 'kind=SCREENSHOT', Buffer.from('not a png'), { 'content-type': 'image/png' })).status, 415, 'zaglavlju se ne vjeruje');
  assert.equal((await upload(r.body.token, 'kind=SCREENSHOT&commandId=nope', PNG)).status, 404);
  const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
  assert.equal((await upload(r.body.token, 'kind=SCREENSHOT', big)).status, 413);

  const ok = await upload(r.body.token, `kind=SCREENSHOT&commandId=${cmd.id}`, PNG, { 'content-type': 'text/plain' });
  assert.equal(ok.status, 201);
  const up = (await ok.json()) as { fileId: string; mime: string; sha256: string };
  assert.equal(up.mime, 'image/png');
  const f = await db.mdmFile.findUniqueOrThrow({ where: { id: up.fileId } });
  assert.equal(f.kind, 'SCREENSHOT');
  assert.equal(f.orgId, s.org.id);
  assert.equal(f.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.equal(((await db.mdmCommand.findUniqueOrThrow({ where: { id: cmd.id } })).result as { fileId: string }).fileId, up.fileId);
  const res = await postResult(r.body.token, cmd.id, { ok: true, result: { width: 1 } });
  assert.equal(res.status, 200);
  assert.deepEqual((await db.mdmCommand.findUniqueOrThrow({ where: { id: cmd.id } })).result, { fileId: up.fileId, width: 1 });

  const jpg = await upload(r.body.token, 'kind=SCREENSHOT', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  assert.equal(((await jpg.json()) as { mime: string }).mime, 'image/jpeg');
  const log = await upload(r.body.token, 'kind=LOGS', Buffer.from('2026-09-24 12:00 start\nčšž ok\n'), { 'x-file-name': '../../etc/passwd' });
  assert.equal(log.status, 201);
  const logFile = await db.mdmFile.findUniqueOrThrow({ where: { id: ((await log.json()) as { fileId: string }).fileId } });
  assert.equal(logFile.mime, 'text/plain; charset=utf-8');
  assert.ok(!logFile.name.includes('/'));
  assert.equal((await upload(r.body.token, 'kind=LOGS', Buffer.from([0x00, 0x01, 0x02]))).status, 415);
  assert.equal((await upload(r.body.token, 'kind=LOGS', Buffer.from([0x1f, 0x8b, 0x08, 0, 0]))).status, 201, 'gzip');

  for (let i = 0; i < 21; i++) assert.equal((await upload(r.body.token, 'kind=SCREENSHOT', PNG)).status, 201);
  assert.equal(await db.mdmUpload.count({ where: { deviceId: r.body.deviceId, kind: 'SCREENSHOT' } }), 20);
  assert.equal(await db.mdmFile.count({ where: { companyId: s.companyId, kind: 'SCREENSHOT' } }), 20);
  assert.equal(await db.mdmFile.count({ where: { id: up.fileId } }), 0, 'najstarija obrisana');
});

test('preuzimanje: samo dodijeljene datoteke, Range, sažetak; dopuna skraćenih naredbi', async () => {
  const s = await setup();
  const a = await register({ hardwareId: 'hw-dl-a', enrollToken: await enrollToken(s) });
  // uređaj bez profila (bez lokacije) — nema ništa dodijeljeno
  const b = await register({ hardwareId: 'hw-dl-b' });
  await db.mdmDevice.update({ where: { id: b.body.deviceId }, data: { status: 'ENROLLED', orgId: s.org.id, enrollCode: null } });

  const full = await getFile(a.body.token, s.file.id);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('x-content-sha256'), s.file.sha256);
  assert.equal(full.headers.get('content-length'), String(s.file.size));
  const bytes = Buffer.from(await full.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), s.file.sha256);

  const part = await getFile(a.body.token, s.file.id, { range: 'bytes=100-' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-${s.file.size - 1}/${s.file.size}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100));
  const suffix = await getFile(a.body.token, s.file.id, { range: 'bytes=-10' });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-10));
  assert.equal((await getFile(a.body.token, s.file.id, { range: `bytes=${s.file.size}-` })).status, 416);
  assert.equal((await getFile(a.body.token, s.file.id, { range: 'bytes=0-9', 'if-range': '"other"' })).status, 200, 'promijenjena datoteka → cijela');
  const head = await getFile(a.body.token, s.file.id, {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(s.file.size));

  assert.equal((await getFile(b.body.token, s.file.id)).status, 403, 'nije u konfiguraciji uređaja B');
  assert.equal((await getFile(a.body.token, s.otherFile.id)).status, 403, 'nije dodijeljena');
  assert.equal((await getFile(a.body.token, 'nepostoji')).status, 404);

  // snimke zaslona se ne preuzimaju kroz API agenta
  const up = await upload(a.body.token, 'kind=SCREENSHOT', PNG);
  assert.equal((await getFile(a.body.token, ((await up.json()) as { fileId: string }).fileId)).status, 404);

  // PUSH_FILE i INSTALL_APP u skraćenom obliku: poslužitelj dopunjuje, preuzimanje dopušteno dok naredba traje
  await queue(s, [b.body.deviceId], 'PUSH_FILE', { fileId: s.otherFile.id, targetPath: 'C:/WMS/cjenik.csv' });
  await queue(s, [b.body.deviceId], 'INSTALL_APP', { appId: s.app.id });
  const cmds = (await checkin(b.body.token)).body.commands;
  const push = cmds.find((c) => c.type === 'PUSH_FILE')!;
  assert.equal(push.payload.downloadPath, `/api/mdm/agent/files/${s.otherFile.id}`);
  assert.equal(push.payload.sha256, s.otherFile.sha256);
  assert.equal(push.payload.targetPath, 'C:/WMS/cjenik.csv');
  const inst = cmds.find((c) => c.type === 'INSTALL_APP')!;
  assert.equal(inst.payload.packageName, 'hr.test.pos');
  assert.equal(inst.payload.versionCode, 120);
  assert.equal(inst.payload.downloadPath, `/api/mdm/agent/files/${s.file.id}`);
  assert.equal((await getFile(b.body.token, s.otherFile.id)).status, 200);
  assert.equal((await getFile(b.body.token, s.file.id)).status, 200);
  await postResult(b.body.token, push.id, { ok: true });
  assert.equal((await getFile(b.body.token, s.otherFile.id)).status, 403, 'nakon završetka naredbe više nije dostupna');
  const pend = await register({ hardwareId: 'hw-dl-p' });
  assert.equal((await getFile(pend.body.token, s.file.id)).status, 403, 'uređaj na čekanju');
});

test('instalacije agenta: 404 dok nisu izgrađene, zatim datoteka i install.ps1 s ključem', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dl = (name: string, qs = '', headers: Record<string, string> = {}) =>
    R.download.GET(req(`/download/${name}${qs}`, { method: 'GET', headers }), { params: Promise.resolve({ artifact: name }) });
  const missing = await dl('android');
  assert.equal(missing.status, 404);
  assert.match(((await missing.json()) as { error: string }).error, /nije izgrađen/);
  assert.equal((await dl('nesto')).status, 404);

  const dir = process.env.MDM_AGENT_DIR!;
  await mkdir(path.join(dir, 'android'), { recursive: true });
  await mkdir(path.join(dir, 'windows'), { recursive: true });
  const apk = Buffer.from('PK apk content');
  await writeFile(path.join(dir, 'android', 'app-release.apk'), apk);
  await writeFile(path.join(dir, 'windows', 'install.ps1'), '$Server = "__MDM_SERVER_URL__"\n$Token = "__MDM_ENROLL_TOKEN__"\n');
  const a = await dl('android');
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('x-content-sha256'), createHash('sha256').update(apk).digest('hex'));
  assert.deepEqual(Buffer.from(await a.arrayBuffer()), apk);
  const ps = await (await dl('windows-install', '?token=abc_DEF-1')).text();
  assert.match(ps, /\$Server = "http:\/\/localhost:3100"/);
  assert.match(ps, /\$Token = "abc_DEF-1"/);
  const evil = await (await dl('windows-install', '?token=a";rm -r /')).text();
  assert.match(evil, /\$Token = ""/);
  const info = (await (await dl('info')).json()) as Record<string, { available: boolean; sha256Base64Url?: string }>;
  assert.equal(info.android.available, true);
  assert.equal(info.windows.available, false);
  assert.equal(info.android.sha256Base64Url, createHash('sha256').update(apk).digest('base64url'));
});
