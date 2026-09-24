import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSendCommand, configFingerprint, deviceAlerts, enrollCode, isOnline, mergeConfig } from '../src/domain/mdm';

test('prava na naredbe', () => {
  assert.ok(canSendCommand('REBOOT', 'ANDROID', 'ops', false));
  assert.ok(!canSendCommand('INSTALL_APP', 'ANDROID', 'ops', false));
  assert.ok(canSendCommand('INSTALL_APP', 'WINDOWS', 'edit', false));
  assert.ok(!canSendCommand('WIPE', 'ANDROID', 'edit', false), 'wipe samo vlasnik');
  assert.ok(canSendCommand('WIPE', 'ANDROID', 'edit', true));
  assert.ok(!canSendCommand('WIPE', 'WINDOWS', 'edit', true), 'wipe nije za Windows');
  assert.ok(!canSendCommand('RUN_SCRIPT', 'ANDROID', 'edit', true));
});

test('online i upozorenja', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  assert.ok(isOnline(new Date('2026-09-24T11:58:30Z'), now));
  assert.ok(!isOnline(new Date('2026-09-24T11:55:00Z'), now));
  const base = { status: 'ENROLLED' as const, lastSeenAt: now, batteryLevel: 50, charging: false, storageFreeMb: 5000, storageTotalMb: 32000, configVersion: 3, appliedConfigVersion: 3 };
  assert.deepEqual(deviceAlerts(base, now), []);
  assert.deepEqual(deviceAlerts({ ...base, batteryLevel: 10 }, now), ['BATTERY']);
  assert.deepEqual(deviceAlerts({ ...base, batteryLevel: 10, charging: true }, now), []);
  assert.deepEqual(deviceAlerts({ ...base, storageFreeMb: 1000 }, now), ['STORAGE']);
  assert.deepEqual(deviceAlerts({ ...base, lastSeenAt: new Date('2026-09-24T10:00:00Z') }, now), ['OFFLINE']);
  assert.deepEqual(deviceAlerts({ ...base, configVersion: 4 }, now), ['CONFIG']);
  assert.deepEqual(deviceAlerts({ ...base, status: 'PENDING' }, now), []);
});

test('kod za upis ima 6 znamenki', () => {
  assert.equal(enrollCode(() => 0), '100000');
  assert.equal(enrollCode(() => 0.999999), '999999');
});

test('spajanje profila i izmjena uređaja', () => {
  const merged = mergeConfig(
    { settings: { kiosk: true, restrictions: { noInstallApps: true, noSettings: true } }, apps: [{ appId: 'a', autoStart: true }, { appId: 'b' }] },
    { settings: { adb: true, restrictions: { noSettings: false } }, apps: [{ appId: 'b', hidden: true }, { appId: 'c' }] },
  );
  assert.deepEqual(merged.settings, { kiosk: true, adb: true, restrictions: { noInstallApps: true, noSettings: false } });
  assert.deepEqual(merged.apps, [{ appId: 'a', autoStart: true }, { appId: 'b', hidden: true }, { appId: 'c' }]);
});

test('otisak konfiguracije ne ovisi o redoslijedu ključeva', () => {
  assert.equal(configFingerprint({ settings: { a: 1, b: 2 }, apps: [] }), configFingerprint({ apps: [], settings: { b: 2, a: 1 } }));
  assert.notEqual(configFingerprint({ settings: { a: 1 }, apps: [] }), configFingerprint({ settings: { a: 2 }, apps: [] }));
});
