/** QA t5 krug 2: pretraga partnera samo za module koji ga biraju; početna = prvi dopušteni modul. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermissions, ROLE_DEFAULTS } from '../src/domain/permissions';
import { canSearchPartners } from '../src/lib/partner-access';
import { homeHref } from '../src/components/layout/nav-items';

const only = (p: Record<string, string>) => resolvePermissions('WAREHOUSE', { ...Object.fromEntries(Object.keys(ROLE_DEFAULTS.WAREHOUSE).map((m) => [m, 'none'])), ...p } as never);

test('partneri: pretraga traži modul koji stvarno bira partnera', () => {
  assert.equal(canSearchPartners({ role: 'WAREHOUSE', perms: only({}) }), false);
  assert.equal(canSearchPartners({ role: 'WAREHOUSE', perms: only({ mdm: 'view' }) }), false, 'MDM pregled nema odabir partnera');
  assert.equal(canSearchPartners({ role: 'WAREHOUSE', perms: only({ mdm: 'ops' }) }), false);
  assert.equal(canSearchPartners({ role: 'WAREHOUSE', perms: only({ mdm: 'edit' }) }), true, 'obrazac organizacije');
  assert.equal(canSearchPartners({ role: 'WAREHOUSE', perms: only({ service: 'edit' }) }), false, 'servis ne bira partnera');
  assert.equal(canSearchPartners({ role: 'WAREHOUSE', perms: only({ sales: 'view' }) }), true, 'filtar računa');
  assert.equal(canSearchPartners({ role: 'DISTRIBUTOR', perms: resolvePermissions('DISTRIBUTOR', {}) }), false, 'vanjski korisnik nikad');
});

test('početna: prvi dopušteni modul redoslijedom izbornika', () => {
  const u = (p: Record<string, string>, extra: { isAdmin?: boolean; canDanger?: boolean } = {}) => ({ perms: only(p), isAdmin: false, canDanger: false, ...extra });
  assert.equal(homeHref(u({ dashboard: 'view', sales: 'edit' })), '/');
  assert.equal(homeHref(u({ sales: 'view', reports: 'view' })), '/prodaja/racuni');
  assert.equal(homeHref(u({ reports: 'view' })), '/izvjestaji');
  assert.equal(homeHref({ perms: resolvePermissions('CLIENT', {}), isAdmin: false, canDanger: false }), '/mdm');
  assert.equal(homeHref(u({})), '/postavke/moj-racun', 'bez ijednog modula');
  assert.equal(homeHref(u({ log: 'view' })), '/postavke/dnevnik');
});
