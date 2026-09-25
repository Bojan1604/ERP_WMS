import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieSecure } from '../src/domain/cookie-secure';

test('kolačić prijave: Secure samo preko HTTPS-a (mobitel na http://192.168… mora ostati prijavljen)', () => {
  assert.equal(cookieSecure(undefined, 'http'), false);
  assert.equal(cookieSecure(undefined, null), false);
  assert.equal(cookieSecure(undefined, 'https'), true);
  assert.equal(cookieSecure(undefined, 'https, http'), true);
  assert.equal(cookieSecure(undefined, 'HTTPS'), true);
  assert.equal(cookieSecure('true', 'http'), true);
  assert.equal(cookieSecure('false', 'https'), false);
});
