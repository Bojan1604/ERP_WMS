import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRateLimiter, daysUntil, generatePortalPassword, portalDeviceKind, portalDeviceState, publicTimeline } from '../src/domain/portal';

test('portal: generirana lozinka ima 12 znakova, mala i velika slova i znamenku, bez dvosmislenih znakova', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const p = generatePortalPassword((n) => randomBytes(n));
    assert.equal(p.length, 12);
    assert.match(p, /[a-z]/);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[0-9]/);
    assert.doesNotMatch(p, /[0O1lI]/);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
});

test('portal: vrsta i stanje uređaja', () => {
  assert.equal(portalDeviceKind('RENTED', 'U najmu'), 'najam');
  assert.equal(portalDeviceKind('SOLD', 'Prodan'), 'kupnja');
  assert.equal(portalDeviceKind('SERVICE', 'Na servisu'), 'na servisu');
  assert.equal(portalDeviceState({ openOrderLabel: 'Prijavljeno', warrantyEnd: '2030-01-01' }, '2026-01-01'), 'u servisu · Prijavljeno');
  assert.equal(portalDeviceState({ openOrderLabel: null, warrantyEnd: '2026-01-01' }, '2026-01-01'), 'u jamstvu');
  assert.equal(portalDeviceState({ openOrderLabel: null, warrantyEnd: '2025-12-31' }, '2026-01-01'), 'jamstvo isteklo');
  assert.equal(portalDeviceState({ openOrderLabel: null, warrantyEnd: null }, '2026-01-01'), 'aktivan');
  assert.equal(daysUntil('2026-01-11', '2026-01-01'), 10);
});

test('portal: javni tijek bez internih napomena, imena i snimke; uzastopni isti statusi spojeni', () => {
  const raw = [
    { at: '2026-01-01T10:00:00Z', status: 'REPORTED', by: 'Ana (portal)', note: 'Nalog otvoren', prev: { state: 'RENTED' } },
    { at: '2026-01-02T10:00:00Z', status: 'RECEIVED', by: 'Marko', note: 'interno: kupac nervozan' },
    { at: '2026-01-03T10:00:00Z', status: 'REPAIRED', by: 'Marko' },
    { at: '2026-01-04T10:00:00Z', status: 'REPAIRED', by: 'Marko', note: 'Uređaj vraćen na skladište Glavno' },
  ];
  const t = publicTimeline(raw, { at: 'x', status: 'REPORTED' });
  assert.deepEqual(t, [
    { at: '2026-01-01T10:00:00Z', status: 'REPORTED' },
    { at: '2026-01-02T10:00:00Z', status: 'RECEIVED' },
    { at: '2026-01-03T10:00:00Z', status: 'REPAIRED' },
  ]);
  assert.deepEqual(publicTimeline(null, { at: 'x', status: 'RECEIVED' }), [{ at: 'x', status: 'RECEIVED' }]);
});

test('portal: ograničenje pokušaja prijave', () => {
  let now = 1_000;
  const rl = createRateLimiter({ max: 3, windowMs: 60_000, now: () => now });
  for (let i = 0; i < 3; i++) {
    assert.equal(rl.blocked('a'), false);
    rl.fail('a');
  }
  assert.equal(rl.blocked('a'), true);
  assert.equal(rl.blocked('b'), false);
  now += 60_001;
  assert.equal(rl.blocked('a'), false);
  rl.fail('a');
  rl.reset('a');
  assert.equal(rl.blocked('a'), false);
});
