/** „Dohvati" na partneru: tumačenje odgovora Sudskog registra, VIES-a i AMS-a (bez mreže). */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { amsRegistered, parseSudreg, parseVies, sudregError, titleCase } from '../src/domain/company-lookup';
import { eposlovanjeProvider } from '../src/server/fiscal/einvoice';
import { lookupPartner } from '../src/server/lookup';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SUDREG_CLIENT_ID;
  delete process.env.SUDREG_CLIENT_SECRET;
});

// oblik odgovora sudreg-data.gov.hr API v3 (javni/detalji_subjekta, expand_relations=true)
const SUDREG = {
  mbs: 80123456,
  oib: 12345678903,
  status: 1,
  tvrtka: { ime: 'KLC TECH društvo s ograničenom odgovornošću za trgovinu i usluge' },
  skracena_tvrtka: { ime: 'KLC Tech d.o.o.' },
  sjediste: { naziv_naselja: 'Zagreb', ulica: 'Ilica', kucni_broj: 10, kucni_podbroj: 'a', postanski_broj: '10000' },
  pravni_oblik: { vrsta_pravnog_oblika: { kratica: 'd.o.o.', naziv: 'društvo s ograničenom odgovornošću' } },
  email_adrese: [{ adresa: 'stara@klc.hr' }, { adresa: 'info@klc.hr' }],
  postupci: [{ postupak: 1 }],
};

test('Sudski registar: skraćeni naziv, adresa, poštanski broj, e-adresa, status', () => {
  const i = parseSudreg(SUDREG);
  assert.equal(i.found, true);
  assert.equal(i.name, 'KLC Tech d.o.o.');
  assert.match(i.fullName, /društvo s ograničenom/);
  assert.equal(i.street, 'Ilica 10a');
  assert.equal(i.zip, '10000');
  assert.equal(i.city, 'Zagreb');
  assert.equal(i.email, 'info@klc.hr');
  assert.equal(i.legalForm, 'd.o.o.');
  assert.equal(i.mbs, '80123456');
  assert.equal(i.status, 'aktivan');
  assert.equal(i.active, true);
});

test('Sudski registar: stečaj i brisan subjekt nisu aktivni; greška 505 = nije u registru', () => {
  assert.equal(parseSudreg({ ...SUDREG, postupci: [{ postupak: 2 }] }).active, false);
  assert.equal(parseSudreg({ ...SUDREG, status: 2 }).active, false);
  assert.equal(parseSudreg({ ...SUDREG, tvrtke: [{ ime: 'Stari naziv' }, { ime: 'Novi naziv' }], tvrtka: undefined, skracena_tvrtka: undefined }).name, 'Novi naziv');
  assert.deepEqual(sudregError([{ error_code: 505, error_message: 'Nema podataka' }]), { code: 505, message: 'Nema podataka' });
  assert.equal(sudregError(SUDREG), null);
});

test('VIES: naziv i adresa iz jednog retka, velika slova u normalna', () => {
  const i = parseVies({ isValid: true, name: 'KLC TECH D.O.O.', address: 'ILICA 10A, 10000 ZAGREB' }, 'HR', '12345678903');
  assert.equal(i.found, true);
  assert.equal(i.name, 'Klc Tech d.o.o.');
  assert.equal(i.street, 'Ilica 10a');
  assert.equal(i.zip, '10000');
  assert.equal(i.city, 'Zagreb');
  assert.equal(i.vatId, 'HR12345678903');
  assert.equal(parseVies({ isValid: false, name: '---' }, 'HR', '1').found, false);
  assert.equal(titleCase('Već Normalno'), 'Već Normalno');
});

test('AMS: različiti oblici odgovora posrednika', () => {
  assert.equal(amsRegistered(200, { registered: true }), true);
  assert.equal(amsRegistered(200, { exists: false }), false);
  assert.equal(amsRegistered(200, { result: 'true' }), true);
  assert.equal(amsRegistered(200, {}), true);
});

test('ePoslovanje ams/check: shema 9934 i OIB u tijelu, ključ u zaglavlju', async () => {
  let seen: { url: string; body: unknown; auth: string | null } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('Authorization') };
    return new Response(JSON.stringify({ registered: false }), { status: 200 });
  }) as typeof fetch;
  const r = await eposlovanjeProvider('KLJUC', 'TEST').amsCheck!('12345678903');
  assert.equal(r.ok, true);
  assert.equal(r.registered, false);
  assert.equal(seen!.url, 'https://test.eposlovanje.hr/api/v2/ams/check');
  assert.deepEqual(seen!.body, { schema: '9934', identifier: '12345678903' });
  assert.equal(seen!.auth, 'KLJUC');
});

test('Dohvati bez pristupa Sudskom registru koristi VIES; neispravan OIB se ne šalje', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ isValid: true, name: 'KLC TECH D.O.O.', address: 'ILICA 10A\n10000 ZAGREB' }), { status: 200 });
  }) as typeof fetch;
  const r = await lookupPartner('nema-firme', { oib: '12345678903', vatId: null, country: 'HR' });
  assert.equal(r.info?.source, 'vies');
  assert.equal(r.info?.city, 'Zagreb');
  assert.match(r.notes.join(' '), /VIES/);
  // nazivi varijabli okruženja ne idu u sučelje
  assert.doesNotMatch(r.notes.join(' '), /SUDREG_CLIENT_ID/);
  assert.ok(urls[0].endsWith('/ms/HR/vat/12345678903'));
  const bad = await lookupPartner('x', { oib: '12345678900', vatId: null, country: 'HR' });
  assert.equal(bad.info, null);
});

test('Dohvati: VIES odbije (HTTP 403) — ljudska poruka bez HTTP koda', async () => {
  globalThis.fetch = (async () => new Response('Forbidden', { status: 403 })) as typeof fetch;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await lookupPartner('nema-firme', { oib: '12345678903', vatId: null, country: 'HR' });
    assert.match(r.info?.error ?? '', /trenutno nije dostupan/);
    assert.doesNotMatch(r.info?.error ?? '', /HTTP|403/);
  } finally {
    console.warn = warn;
  }
});

test('Dohvati sa Sudskim registrom: token pa detalji subjekta', async () => {
  process.env.SUDREG_CLIENT_ID = 'id';
  process.env.SUDREG_CLIENT_SECRET = 'tajna';
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    if (url.includes('oauth/token')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify(SUDREG), { status: 200 });
  }) as typeof fetch;
  const r = await lookupPartner('nema-firme', { oib: '12345678903', vatId: null, country: 'HR' });
  assert.equal(r.info?.source, 'sudreg');
  assert.equal(r.info?.name, 'KLC Tech d.o.o.');
  assert.ok(urls.some((u) => u.includes('identifikator=12345678903')));
});
