import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dupNoteError, parseSerials, returnOnCost, serialRange } from '../src/domain/warehouse';

test('zalijepljeni serijski brojevi: obrezivanje, prazni redovi, ponavljanja', () => {
  const r = parseSerials('  SN1 \r\nSN2\n\nSN1\n\tSN3\n');
  assert.deepEqual(r.serials, ['SN1', 'SN2', 'SN3']);
  assert.deepEqual(r.repeated, ['SN1']);
  assert.deepEqual(parseSerials('').serials, []);
});

test('raspon serijskih s nadopunom nulama', () => {
  assert.deepEqual(serialRange('SN-', 8, 11, 4), ['SN-0008', 'SN-0009', 'SN-0010', 'SN-0011']);
  assert.deepEqual(serialRange('A', 1, 3), ['A1', 'A2', 'A3']);
  assert.deepEqual(serialRange('A', 5, 3), []);
  assert.equal(serialRange('X', 1, 10_000, 0, 600).length, 600);
});

test('duplikat serijskog traži različitu razlikovnu napomenu', () => {
  assert.equal(dupNoteError('S1', null, []), null);
  assert.match(dupNoteError('S1', '', [{ dupNote: null }])!, /upišite razlikovnu napomenu/);
  assert.match(dupNoteError('S1', 'Zamjenski', [{ dupNote: 'zamjenski ' }])!, /mora razlikovati/);
  assert.equal(dupNoteError('S1', 'drugi', [{ dupNote: null }, { dupNote: 'prvi' }]), null);
});

test('povrat na nabavnu', () => {
  assert.equal(returnOnCost(150, 100), 50);
  assert.equal(returnOnCost(50, 0), null);
});
