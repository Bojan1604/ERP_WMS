import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScan, gs1Serial, itemIdFromLink, scanCandidates, serialLabel, stocktakeCounts } from '../src/domain/warehouse';
import { cameraErrorMessage, cameraSupport, createDedupe, createWedgeDetector } from '../src/components/scan/core';

test('oblici koda: prefiksi, kontrolni znakovi, SN bez razdjelnika ostaje', () => {
  assert.deepEqual(scanCandidates('  ABC123 '), ['ABC123']);
  assert.deepEqual(scanCandidates('S/N: ABC123'), ['S/N: ABC123', 'ABC123']);
  assert.deepEqual(scanCandidates('SN:XY-9'), ['SN:XY-9', 'XY-9']);
  assert.deepEqual(scanCandidates('Serial No. 55AA'), ['Serial No. 55AA', '55AA']);
  // mnogi serijski počinju sa „SN" — bez razdjelnika se ne skida
  assert.deepEqual(scanCandidates('SN0001'), ['SN0001']);
  assert.deepEqual(scanCandidates('AB\u0000C\r\n'), ['ABC']);
  assert.deepEqual(scanCandidates('   '), []);
  assert.deepEqual(scanCandidates('x'.repeat(200)), []);
});

test('GS1: serijski iz AI 21 (zagrade i GS razdjelnik)', () => {
  assert.equal(gs1Serial('(01)04012345678901(21)SN777'), 'SN777');
  assert.equal(gs1Serial('0104012345678901' + '17261231' + '21ABC\u001d10LOT1'), 'ABC');
  assert.equal(gs1Serial('0104012345678901' + '10LOT9\u001d' + '21XYZ'), 'XYZ');
  assert.equal(gs1Serial(']d20104012345678901' + '21Q1'), 'Q1');
  assert.equal(gs1Serial('ABC123'), null);
  assert.deepEqual(scanCandidates('0104012345678901' + '21SER-5'), ['0104012345678901' + '21SER-5', 'SER-5']);
});

test('QR poveznica na karticu uređaja', () => {
  assert.equal(itemIdFromLink('https://erp.firma.hr/skladiste/cmueh2pkz00u77dzc8dwaw3sk'), 'cmueh2pkz00u77dzc8dwaw3sk');
  assert.equal(itemIdFromLink('http://localhost:3100/skladiste/cmueh2pkz00u77dzc8dwaw3sk?x=1'), 'cmueh2pkz00u77dzc8dwaw3sk');
  // bez APP_URL naljepnica nosi samo putanju
  assert.equal(itemIdFromLink('/skladiste/cmueh2pkz00u77dzc8dwaw3sk'), 'cmueh2pkz00u77dzc8dwaw3sk');
  assert.equal(itemIdFromLink(' /skladiste/cmueh2pkz00u77dzc8dwaw3sk\n'), 'cmueh2pkz00u77dzc8dwaw3sk');
  assert.equal(itemIdFromLink('skladiste/cmueh2pkz00u77dzc8dwaw3sk'), null);
  assert.equal(itemIdFromLink('https://erp.firma.hr/skladiste/izlaz'), null);
  assert.equal(itemIdFromLink('SN123'), null);
});

test('inventura: razvrstavanje i brojači', () => {
  assert.equal(classifyScan(null, 'w1'), 'unknown');
  assert.equal(classifyScan({ state: 'SOLD', warehouseId: null }, 'w1'), 'notInStock');
  assert.equal(classifyScan({ state: 'IN_STOCK', warehouseId: 'w2' }, 'w1'), 'wrongWarehouse');
  assert.equal(classifyScan({ state: 'IN_STOCK', warehouseId: 'w1' }, 'w1'), 'found');
  assert.equal(classifyScan({ state: 'IN_STOCK', warehouseId: 'w2' }, null), 'found');
  assert.deepEqual(stocktakeCounts(10, 7, 5), { expected: 10, found: 5, missing: 5, extra: 2, scanned: 7 });
  assert.equal(serialLabel('S1', 'drugi'), 'S1 (drugi)');
  assert.equal(serialLabel('S1', null), 'S1');
});

test('skener: isti kod unutar 2 s se ne ponavlja', () => {
  const ok = createDedupe(2000);
  assert.equal(ok('A', 0), true);
  assert.equal(ok('A', 500), false);
  assert.equal(ok('B', 600), true);
  assert.equal(ok('A', 1900), false); // prozor se produžuje dok je kod u kadru
  assert.equal(ok('A', 4000), true);
});

test('ručni čitač: brzi niz + Enter je kod, tipkanje čovjeka nije', () => {
  const w = createWedgeDetector({ maxGapMs: 50, minLength: 3 });
  const type = (s: string, gap: number, start = 0) => {
    let t = start;
    let out: string | null = null;
    for (const ch of s) {
      out = w.key(ch, t) ?? out;
      t += gap;
    }
    return { out, t };
  };
  let r = type('SN1234', 10);
  assert.equal(w.key('Enter', r.t), 'SN1234');
  r = type('abc', 200, 1000);
  assert.equal(w.key('Enter', r.t), null);
  // Shift između znakova (velika slova) ne prekida niz
  w.key('Shift', 5000);
  r = type('XY9', 8, 5001);
  assert.equal(w.key('Enter', r.t), 'XY9');
  // Enter tek nakon pauze nije od čitača
  r = type('QWE', 8, 9000);
  assert.equal(w.key('Enter', r.t + 2000), null);
  // prekratko
  r = type('AB', 5, 20000);
  assert.equal(w.key('Enter', r.t), null);
});

test('kamera: HTTPS/localhost i poruke grešaka', () => {
  assert.equal(cameraSupport({ isSecureContext: false, hostname: '192.168.1.5', hasGetUserMedia: true }), 'insecure');
  assert.equal(cameraSupport({ isSecureContext: false, hostname: 'localhost', hasGetUserMedia: true }), 'ok');
  assert.equal(cameraSupport({ isSecureContext: true, hostname: 'erp.hr', hasGetUserMedia: false }), 'unsupported');
  assert.match(cameraErrorMessage('NotAllowedError'), /odbijen/);
  assert.match(cameraErrorMessage('NotFoundError'), /nije pronađena/);
  assert.match(cameraErrorMessage(undefined), /ručno/);
});
