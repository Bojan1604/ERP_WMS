import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countLabel, plural } from '../src/domain/plural';

test('hrvatska množina uz broj (countLabel)', () => {
  const doc = (n: number) => countLabel(n, 'dokument', 'dokumenta', 'dokumenata');
  assert.equal(doc(1), '1 dokument');
  assert.equal(doc(3), '3 dokumenta');
  assert.equal(doc(5), '5 dokumenata');
  assert.equal(doc(11), '11 dokumenata');
  assert.equal(doc(12), '12 dokumenata');
  assert.equal(doc(21), '21 dokument');
  assert.equal(doc(22), '22 dokumenta');
  assert.equal(doc(0), '0 dokumenata');
  assert.equal(countLabel(1, 'stavka', 'stavke', 'stavki'), '1 stavka');
  assert.equal(countLabel(1234, 'stavka', 'stavke', 'stavki', (n) => n.toLocaleString('de-DE')), '1.234 stavke');
  assert.equal(`${doc(3)} ${plural(3, 'označen', 'označena', 'označeno')}`, '3 dokumenta označena');
});
