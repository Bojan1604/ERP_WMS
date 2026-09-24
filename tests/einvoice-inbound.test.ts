/**
 * Ulazni eRačuni kod posrednika ePoslovanje.hr (API v2): oblik zahtjeva i
 * tumačenje odgovora — bez mreže (lažni fetch).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { demoProvider, eposlovanjeProvider } from '../src/server/fiscal/einvoice';
import { demoIncoming, tinyPdf } from '../src/server/fiscal/einvoice-demo';
import {
  alreadyInStatus, businessStatusLabel, changedOnCandidates, extractXml, incomingList, normalizeIncoming,
} from '../src/domain/einvoice-inbound';
import { parseUbl, ublPdf } from '../src/domain/ubl-parse';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Seen = { url: string; method: string; body: Record<string, unknown> | null; auth: string | null };

/** Lažni fetch: odgovori redom; bilježi svaki zahtjev. */
function mockFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const seen: Seen[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get('Authorization') });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return seen;
}

const SAMPLE_XML = demoIncoming(new Date('2026-03-10T10:00:00Z'))[0].xml;

test('document/incoming: URL (limit/offset, bez datuma), ključ u zaglavlju, normalizacija zapisa', async () => {
  const seen = mockFetch([
    {
      body: {
        items: [
          { id: 101, documentNumber: 'R-1', issueDate: '2026-03-01T00:00:00', insertedOn: '2026-03-02T08:00:00', supplierName: 'Dob d.o.o.', supplierIdentifier: 'HR69435151530', payableAmount: '125.00', taxAmount: 25, status: 4 },
          { documentId: 'abc', invoiceNumber: 'X-2', sender: { name: 'Drugi', identifier: '9934:84123456785' }, totalAmount: 10 },
          { note: 'bez id-a — preskače se' },
        ],
      },
    },
  ]);
  const r = await eposlovanjeProvider('KLJUC', 'PROD').incoming!({ limit: 200 });
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, 'https://eracun.eposlovanje.hr/api/v2/document/incoming?limit=200&offset=0');
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].auth, 'KLJUC');
  assert.equal(r.docs!.length, 2);
  assert.deepEqual(r.docs![0], {
    id: '101', number: 'R-1', issueDate: '2026-03-01', insertedOn: '2026-03-02', supplierName: 'Dob d.o.o.', supplierOib: '69435151530',
    net: 0, vat: 25, total: 125, status: 'zaprimljen',
  });
  assert.equal(r.docs![1].id, 'abc');
  assert.equal(r.docs![1].supplierOib, '84123456785');
  assert.equal(r.docs![1].supplierName, 'Drugi');
});

test('document/incoming: goli niz u odgovoru; greška posrednika s porukom', async () => {
  mockFetch([{ body: [{ id: 7, number: 'A' }] }]);
  const ok = await eposlovanjeProvider('K', 'TEST').incoming!();
  assert.deepEqual(ok.docs!.map((d) => d.id), ['7']);

  mockFetch([{ status: 401, body: { message: 'Neispravan API ključ' } }]);
  const bad = await eposlovanjeProvider('K', 'TEST').incoming!();
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'Neispravan API ključ');

  mockFetch([Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })]);
  const net = await eposlovanjeProvider('K', 'TEST').incoming!();
  assert.equal(net.ok, false);
  assert.equal(net.unreachable, true);
});

test('document/get: goli XML, JSON s poljem i base64', async () => {
  const b64 = Buffer.from(SAMPLE_XML).toString('base64');
  for (const body of [SAMPLE_XML, { document: SAMPLE_XML }, { content: b64 }, JSON.stringify(b64)]) {
    const seen = mockFetch([{ body }]);
    const r = await eposlovanjeProvider('K', 'TEST').documentXml!('id/1');
    assert.equal(seen[0].url, 'https://test.eposlovanje.hr/api/v2/document/get/id%2F1');
    assert.equal(r.ok, true, JSON.stringify(body).slice(0, 40));
    assert.equal(parseUbl(r.xml)?.number, 'R-2041/1/1');
  }
  mockFetch([{ body: { message: 'ok' } }]);
  const none = await eposlovanjeProvider('K', 'TEST').documentXml!('9');
  assert.equal(none.ok, false);
  assert.match(none.error!, /XML/);
});

test('changestatus: brojčani status, napomena i changedOn (ISO s pomakom) u tijelu', async () => {
  const seen = mockFetch([{ body: { message: 'Status promijenjen' } }]);
  const r = await eposlovanjeProvider('K', 'TEST').changeStatus!('55', { status: 'REJECTED', note: 'Neispravan iznos' });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://test.eposlovanje.hr/api/v2/document/changestatus/55');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].body!.status, 6);
  assert.equal(seen[0].body!.note, 'Neispravan iznos');
  assert.match(String(seen[0].body!.changedOn), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.equal('partialPaymentAmount' in seen[0].body!, false);
});

test('changestatus: oblik datuma se mijenja dok posrednik ne prihvati; staje na grešci koja nije o obliku', async () => {
  const seen = mockFetch([
    { status: 400, body: { message: 'Datum promjene statusa nije ispravno zadan' } },
    { status: 400, body: { message: 'Datum promjene statusa nije ispravno zadan' } },
    { body: { ok: true } },
  ]);
  const r = await eposlovanjeProvider('K', 'TEST').changeStatus!('1', { status: 'PAID', date: '2026-02-03' });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].body!.status, 8);
  assert.match(String(seen[0].body!.changedOn), /^2026-02-03T12:00:00\.000[+-]\d{2}:\d{2}$/);
  assert.equal(seen[1].body!.changedOn, '2026-02-03T12:00:00');
  assert.match(String(seen[2].body!.statusDate), /^2026-02-03T12:00:00\.000/);
  assert.deepEqual((r as { body?: unknown }).body, seen[2].body);

  const stop = mockFetch([{ status: 404, body: { message: 'Dokument ne postoji' } }]);
  const nf = await eposlovanjeProvider('K', 'TEST').changeStatus!('1', { status: 'ACCEPTED' });
  assert.equal(nf.ok, false);
  assert.equal(nf.error, 'Dokument ne postoji');
  assert.equal(stop.length, 1);

  const all = mockFetch([{ status: 400, body: { message: 'Neispravni ulazni podaci' } }]);
  const fail = await eposlovanjeProvider('K', 'TEST').changeStatus!('1', { status: 'ACCEPTED' });
  assert.equal(fail.ok, false);
  assert.equal(all.length, 6, 'svih šest oblika datuma');
});

test('changestatus: „već se nalazi u statusu" je uspjeh', async () => {
  mockFetch([{ status: 400, body: { message: 'Dokument se već nalazi u statusu kojeg pokušavate postaviti.' } }]);
  const r = await eposlovanjeProvider('K', 'TEST').changeStatus!('1', { status: 'ACCEPTED' });
  assert.equal(r.ok, true);
  assert.equal(r.already, true);
  assert.equal(r.error, undefined);
  assert.equal(alreadyInStatus('Document is already in this status'), true);
  assert.equal(alreadyInStatus('Nije dopušteno'), false);
});

test('djelomično plaćanje šalje partialPaymentAmount', async () => {
  const seen = mockFetch([{ body: {} }]);
  await eposlovanjeProvider('K', 'TEST').changeStatus!('1', { status: 'PARTIAL', partialPaymentAmount: 40.5 });
  assert.equal(seen[0].body!.status, 7);
  assert.equal(seen[0].body!.partialPaymentAmount, 40.5);
});

test('ereporting/rejected: documentId, note, rejectionDate', async () => {
  const seen = mockFetch([{ body: { message: 'Zaprimljeno' } }]);
  const r = await eposlovanjeProvider('K', 'TEST').reportRejected!({ documentId: '55', note: 'Duplikat računa', rejectionDate: '2026-03-10' });
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, 'https://test.eposlovanje.hr/api/v2/ereporting/rejected/55');
  assert.deepEqual(seen[0].body, { documentId: '55', note: 'Duplikat računa', rejectionDate: '2026-03-10' });
});

test('datum promjene statusa: danas s vremenom i pomakom Europe/Zagreb, drugi dan u podne', () => {
  // 10. 7. 2026. 10:20:30.123 UTC = 12:20:30.123 u Zagrebu (ljetno vrijeme, +02:00)
  const summer = new Date(Date.UTC(2026, 6, 10, 10, 20, 30, 123));
  const c = changedOnCandidates(null, summer);
  assert.deepEqual(c[0], { changedOn: '2026-07-10T12:20:30.123+02:00' });
  assert.deepEqual(c[1], { changedOn: '2026-07-10T12:20:30' });
  assert.deepEqual(c[5], { changedOn: '2026-07-10' });
  assert.deepEqual(Object.keys(Object.assign({}, ...c)).sort(), ['changedOn', 'date', 'statusChangeDate', 'statusDate']);
  // zimsko vrijeme +01:00; zadani raniji datum → podne
  const winter = new Date(Date.UTC(2026, 0, 15, 23, 30, 0, 5));
  assert.deepEqual(changedOnCandidates(null, winter)[0], { changedOn: '2026-01-16T00:30:00.005+01:00' });
  assert.deepEqual(changedOnCandidates('2026-01-10', winter)[0], { changedOn: '2026-01-10T12:00:00.000+01:00' });
});

test('pomoćne funkcije: popis, XML, oznake statusa', () => {
  assert.deepEqual(incomingList({ documents: [1] }), [1]);
  assert.deepEqual(incomingList({ nothing: true }), []);
  assert.equal(extractXml({ data: { xml: '<a/>' } }), '<a/>');
  assert.equal(extractXml('bmlqZSB4bWw='), '');
  assert.equal(businessStatusLabel(6), 'odbijen');
  assert.equal(businessStatusLabel('DELIVERED'), 'DELIVERED');
  assert.equal(normalizeIncoming(null).id, '');
});

test('demo posrednik: dva primljena UBL računa (jedan s PDF-om), promjena statusa i prijava bez mreže', async () => {
  globalThis.fetch = (() => {
    throw new Error('demo ne smije zvati mrežu');
  }) as typeof fetch;
  const list = await demoProvider.incoming!();
  assert.equal(list.ok, true);
  assert.equal(list.docs!.length, 2);
  const x = await demoProvider.documentXml!(list.docs![0].id);
  const p = parseUbl(x.xml)!;
  assert.equal(p.supplier.oib, '69435151530');
  assert.equal(p.total, list.docs![0].total);
  const pdf = ublPdf(p)!;
  assert.equal(Buffer.from(pdf.base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.equal(ublPdf(parseUbl((await demoProvider.documentXml!(list.docs![1].id)).xml)!), null);
  assert.equal((await demoProvider.documentXml!('nema')).ok, false);
  assert.equal((await demoProvider.changeStatus!('x', { status: 'ACCEPTED' })).ok, true);
  assert.equal((await demoProvider.reportRejected!({ documentId: 'x', note: 'n', rejectionDate: '2026-01-01' })).ok, true);
  assert.match(tinyPdf('Test'), /^%PDF-1\.4[\s\S]*%%EOF\n$/);
});
