import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWithin, pairCode, safeFileName, sniffMime } from '../src/domain/attachments';
import { BACK_TO_STOCK_STATES, readReceivePayload } from '../src/domain/receive-request';

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

test('prilog: vrsta se prepoznaje po sadržaju, ne po nazivu', () => {
  assert.equal(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0)), 'image/jpeg');
  assert.equal(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'image/png');
  assert.equal(sniffMime(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')), 'image/webp');
  assert.equal(sniffMime(text('%PDF-1.7\n')), 'application/pdf');
  // HTML/SVG preimenovan u .jpg se odbija
  assert.equal(sniffMime(text('<html><script>alert(1)</script>')), null);
  assert.equal(sniffMime(text('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffMime(bytes()), null);
});

test('prilog: siguran naziv datoteke s nastavkom prema vrsti', () => {
  assert.equal(safeFileName('C:\\fake\\path\\IMG_001.HEIC', 'image/jpeg'), 'IMG_001.jpg');
  assert.equal(safeFileName('../../etc/passwd', 'application/pdf'), 'passwd.pdf');
  assert.equal(safeFileName('a"<b>|c?.png', 'image/png'), 'abc.png');
  assert.equal(safeFileName('', 'image/webp'), 'prilog.webp');
  assert.equal(safeFileName(null, 'image/jpeg'), 'prilog.jpg');
  assert.ok(safeFileName('x'.repeat(300), 'image/jpeg').length <= 104);
});

test('prilog: smanjivanje slike čuva omjer i ne povećava', () => {
  assert.deepEqual(fitWithin(4000, 3000, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3000, 4000, 1600), { width: 1200, height: 1600 });
  assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(0, 0, 1600), { width: 1, height: 1 });
});

test('slika naljepnice: uparivanje pročitanog koda s uređajem', () => {
  const devs = [
    { id: 'a', serial: 'SN1234' },
    { id: 'b', serial: 'SN12345' },
    { id: 'c', serial: 'X1' },
  ];
  assert.equal(pairCode(['sn1234'], devs), 'a');
  assert.equal(pairCode(['SN12345'], devs), 'b');
  // GS1: najdulji serijski koji je dio koda
  assert.equal(pairCode(['(01)04012345678901(21)SN12345'], devs), 'b');
  // prekratki serijski se ne traži kao podniz
  assert.equal(pairCode(['ABCX1DEF'], devs), null);
  assert.equal(pairCode(['X1'], devs), 'c');
  assert.equal(pairCode([], devs), null);
  assert.equal(pairCode(['NEPOZNAT'], devs), null);
});

test('zahtjev za zaprimanje: tolerantno čitanje podataka i stanja za povrat', () => {
  const p = readReceivePayload({ serials: ['A', 1, 'B'], returning: ['i1'], warehouseId: 'w', note: 'n', photos: [{ id: 'p1', code: 'A' }, { x: 1 }, null], requesterId: 'u' });
  assert.deepEqual(p.serials, ['A', 'B']);
  assert.deepEqual(p.photos, [{ id: 'p1', code: 'A', itemId: null }]);
  assert.equal(p.ack, false);
  const empty = readReceivePayload(null);
  assert.deepEqual(empty.serials, []);
  assert.equal(empty.warehouseId, '');
  assert.ok(!BACK_TO_STOCK_STATES.includes('IN_STOCK'));
  assert.ok(!BACK_TO_STOCK_STATES.includes('WRITTEN_OFF'));
  assert.ok(BACK_TO_STOCK_STATES.includes('RETURNING'));
});
