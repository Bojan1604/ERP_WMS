/** QA t5: dnevnik promjena bez prava „costs" ne otkriva nabavne cijene ni marže. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCostKey, redactCostDiff, redactCostSummary } from '../src/domain/permissions';

test('dnevnik: razlika bez nabavnih ključeva (i ugniježđeno), pravo „costs" ostaje vidljivo', () => {
  assert.ok(isCostKey('cost') && isCostKey('unitCost') && isCostKey('marginPct') && isCostKey('defaultMarginPct') && isCostKey('costTotal'));
  assert.ok(!isCostKey('costs'), 'naziv prava nije iznos');
  assert.ok(!isCostKey('price') && !isCostKey('name'));
  const d = {
    cost: { from: '1397.06', to: 777.77 },
    serial: { from: 'A', to: 'B' },
    lines: [{ unitCost: 5, qty: 1, marginPct: 20 }],
    permissions: { from: {}, to: { costs: 'view' } },
  };
  assert.deepEqual(redactCostDiff(d, 'item'), { serial: { from: 'A', to: 'B' }, lines: [{ qty: 1 }], permissions: { from: {}, to: { costs: 'view' } } });
  // nabavni dokumenti: skrivaju se i iznosi
  assert.deepEqual(redactCostDiff({ total: 100, netTotal: 80, number: 'P-1' }, 'receipt'), { number: 'P-1' });
  assert.equal(redactCostDiff(null, 'item'), null);
});

test('dnevnik: opis nabavnog dokumenta i marže bez iznosa', () => {
  assert.equal(redactCostSummary('Primka P-2026-0001 — 5 kom, 1234.50 €', 'receipt', 'create'), 'Primka P-2026-0001 — 5 kom, •••');
  assert.equal(redactCostSummary('Primka P-7: knjižen trošak nabave 99.00 €', 'receipt', 'book'), 'Primka P-7: knjižen trošak nabave •••');
  assert.equal(redactCostSummary('Marža modela Sunmi T2: 20 %', 'model', 'margin'), 'Marža modela Sunmi T2: •••');
  assert.equal(redactCostSummary('Račun R-1 izdan, 100.00 €', 'invoice', 'issue'), 'Račun R-1 izdan, 100.00 €', 'prodajni iznosi ostaju');
});
