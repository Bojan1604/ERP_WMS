/** Adresa klijenta iza posrednika (TRUST_PROXY): vjeruje se samo unosu koji dodaje naš posrednik. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrustProxy, pickClientIp } from '../src/domain/client-ip';

test('TRUST_PROXY: zadano 1 posrednik, „none" = zaglavlju se ne vjeruje', () => {
  assert.equal(parseTrustProxy(undefined), 1);
  assert.equal(parseTrustProxy(''), 1);
  assert.equal(parseTrustProxy('none'), 0);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('x'), 1);
});

test('X-Forwarded-For: lažni prvi unos klijenta se ne koristi', () => {
  // klijent pošalje „1.1.1.1", Caddy doda stvarnu adresu na kraj
  assert.equal(pickClientIp('1.1.1.1, 203.0.113.7', 1), '203.0.113.7');
  assert.equal(pickClientIp('203.0.113.7', 1), '203.0.113.7');
  assert.equal(pickClientIp('1.1.1.1, 203.0.113.7, 10.0.0.2', 2), '203.0.113.7');
  assert.equal(pickClientIp('::ffff:203.0.113.7', 1), '203.0.113.7');
  assert.equal(pickClientIp('1.1.1.1, 203.0.113.7', 0), null);
  assert.equal(pickClientIp(null, 1), null);
  assert.equal(pickClientIp('203.0.113.7', 3), null);
});
