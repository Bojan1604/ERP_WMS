import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTANT_CSV_COLUMNS, directionsOf, fileStem, parseKeys, readAccountantFilters } from '../src/domain/accountant';
import { toCsv } from '../src/lib/csv';

test('knjigovođa: zadani filtri su tekući mjesec do danas', () => {
  const f = readAccountantFilters({}, '2026-09-24');
  assert.deepEqual(f, { from: '2026-09-01', to: '2026-09-24', dir: '', sent: '', kind: '', q: '' });
  const g = readAccountantFilters({ od: '2026-01-01', do: 'x', smjer: 'ulazni', poslano: 'ne', vrsta: 'STORNO', q: '  123 ' }, '2026-09-24');
  assert.deepEqual(g, { from: '2026-01-01', to: '2026-09-24', dir: 'in', sent: 'ne', kind: 'STORNO', q: '123' });
  assert.equal(readAccountantFilters({ vrsta: 'toString' }).kind, '');
});

test('knjigovođa: vrsta dokumenta sužava smjer', () => {
  assert.deepEqual(directionsOf({ dir: '', kind: '' }), { out: true, in: true });
  assert.deepEqual(directionsOf({ dir: '', kind: 'INBOUND' }), { out: false, in: true });
  assert.deepEqual(directionsOf({ dir: '', kind: 'CREDIT_NOTE' }), { out: true, in: false });
  assert.deepEqual(directionsOf({ dir: 'in', kind: 'INVOICE' }), { out: false, in: false });
});

test('knjigovođa: ključevi redaka', () => {
  assert.deepEqual(parseKeys('out:a1,in:b2,out:a1,xx:c,in:,out:../x'), { out: ['a1'], in: ['b2'] });
  assert.deepEqual(parseKeys(['in:z']), { out: [], in: ['z'] });
});

test('knjigovođa: naziv datoteke iz broja računa i CSV popis', () => {
  assert.equal(fileStem('12/PP1/1', 'x'), '12-PP1-1');
  assert.equal(fileStem('  ', 'rezerva'), 'rezerva');
  const csv = toCsv(
    [{ dir: 'out' as const, date: '2026-09-02', number: '1/PP1/1', partner: 'Kupac; d.o.o.', oib: '12345678903', kind: 'INVOICE' as const, net: 100.5, vat: 25.13, total: 125.63, status: 'Plaćeno' }],
    ACCOUNTANT_CSV_COLUMNS,
  );
  assert.ok(csv.startsWith('﻿Smjer;Datum;Broj;Partner;OIB;Vrsta;Osnovica;PDV;Ukupno;Status'));
  assert.match(csv, /Izlazni;02\.09\.2026\.?;1\/PP1\/1;"Kupac; d\.o\.o\.";12345678903;Račun;100,5;25,13;125,63;Plaćeno/);
});
