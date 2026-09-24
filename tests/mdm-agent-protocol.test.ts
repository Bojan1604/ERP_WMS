import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckinSchema, CommandResultSchema, RegisterSchema, parseRange, sniffUpload } from '../src/server/mdm/agent';
import { RateLimiter, hashToken, newDeviceToken, parseDeviceAuth } from '../src/server/mdm/agent-auth';

test('ključ uređaja: 32 bajta base64url, zaglavlje Device', () => {
  const t = newDeviceToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(t, newDeviceToken());
  assert.equal(hashToken(t).length, 64);
  assert.equal(parseDeviceAuth(`Device ${t}`), t);
  assert.equal(parseDeviceAuth(`Bearer ${t}`), null);
  assert.equal(parseDeviceAuth('Device short'), null);
  assert.equal(parseDeviceAuth(null), null);
});

test('Range: jedan raspon, sufiks, nastavak; neispravno → invalid', () => {
  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=5-2', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('items=0-1', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null, 'više raspona → cijela datoteka');
});

test('prepoznavanje vrste iz bajtova', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  assert.equal(sniffUpload('SCREENSHOT', png)?.mime, 'image/png');
  assert.equal(sniffUpload('SCREENSHOT', Buffer.from([0xff, 0xd8, 0xff, 0xdb]))?.mime, 'image/jpeg');
  assert.equal(sniffUpload('SCREENSHOT', Buffer.from('GIF89a')), null);
  assert.equal(sniffUpload('SCREENSHOT', Buffer.from('hello')), null);
  assert.equal(sniffUpload('LOGS', Buffer.from('log čšž\n'))?.mime, 'text/plain; charset=utf-8');
  assert.equal(sniffUpload('LOGS', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]))?.mime, 'application/zip');
  assert.equal(sniffUpload('LOGS', Buffer.from([0x1f, 0x8b, 0x08, 0]))?.mime, 'application/gzip');
  assert.equal(sniffUpload('LOGS', png), null, 'binarni sadržaj nije zapisnik');
  assert.equal(sniffUpload('LOGS', Buffer.from([0xc3, 0x28])), null, 'neispravan UTF-8');
});

test('javljanje: neispravna polja se zanemaruju, brojevi ograničavaju, popisi skraćuju', () => {
  const p = CheckinSchema.parse({
    appliedConfigVersion: 'x',
    telemetry: {
      batteryLevel: 120.4,
      wifiSignal: -300,
      storageFreeMb: -5,
      charging: 'yes',
      serial: '  SN1  ',
      model: '',
      osVersion: null,
      apps: [{ packageName: 'a' }, { name: 'bez paketa' }, 'x', { packageName: 'b', versionCode: 1.5 }],
      extra: { big: 'x'.repeat(20_000) },
    },
    events: [...Array.from({ length: 60 }, () => ({ type: 'T', message: 'm' })), { nope: 1 }],
  });
  assert.equal(p.appliedConfigVersion, undefined);
  assert.equal(p.telemetry.batteryLevel, 100);
  assert.equal(p.telemetry.wifiSignal, -150);
  assert.equal(p.telemetry.storageFreeMb, 0);
  assert.equal(p.telemetry.charging, undefined);
  assert.equal(p.telemetry.serial, 'SN1');
  assert.equal(p.telemetry.model, null);
  assert.equal(p.telemetry.osVersion, null);
  assert.deepEqual(p.telemetry.apps, [{ packageName: 'a' }, { packageName: 'b' }]);
  assert.equal(p.telemetry.extra, undefined, 'prevelik extra se odbacuje');
  assert.equal(p.events?.length, 50);
  assert.equal(p.events?.[0].level, 'info');
  assert.deepEqual(CheckinSchema.parse({}).telemetry, {});
  assert.deepEqual(CheckinSchema.parse({ telemetry: 'x' }).telemetry, {});
});

test('registracija i rezultat naredbe', () => {
  assert.throws(() => RegisterSchema.parse({ protocol: 1, platform: 'IOS', hardwareId: 'x' }));
  assert.throws(() => RegisterSchema.parse({ protocol: 1, platform: 'ANDROID', hardwareId: '  ' }));
  const r = RegisterSchema.parse({ protocol: 1, platform: 'WINDOWS', hardwareId: 'abc', model: 'm'.repeat(300), serial: '' });
  assert.equal(r.model?.length, 100);
  assert.equal(r.serial, null);
  assert.throws(() => CommandResultSchema.parse({ ok: true, result: { x: 'y'.repeat(70_000) } }));
  assert.equal(CommandResultSchema.parse({ ok: false, error: 'e'.repeat(3000) }).error?.length, 2000);
});

test('ograničenje učestalosti po ključu', () => {
  const l = new RateLimiter(2, 1000);
  assert.equal(l.take('a', 0), 0);
  assert.equal(l.take('a', 1), 0);
  assert.equal(l.take('a', 2), 1);
  assert.equal(l.take('b', 2), 0);
  assert.equal(l.take('a', 1001), 0, 'novi prozor');
});
