/** Područje C (revizija): skupna sezona/naplata vrijedi tek od prve neizdane rate. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBulkTerms, bulkCutoff } from '../src/domain/plan';
import { pendingInstallments, type ContractDevice, type ContractTerms } from '../src/domain/billing';

const terms = (t: Partial<ContractTerms>): ContractTerms => ({
  status: 'ACTIVE', startDate: '2026-01-01', billing: 'MONTHLY', billingMode: 'IN_ADVANCE', billingDay: 1, ...t,
});
const cover = (itemId: string, periods: string[]) => new Set(periods.map((p) => `${itemId}|${p}`));

test('godišnja → mjesečna: izdana godišnja rata pokriva godinu, mjesečno tek od sljedeće', () => {
  const t = terms({ billing: 'ANNUAL' });
  const d: ContractDevice = { itemId: 'a', monthly: 10, plan: [] };
  const now = '2026-09-25';
  const cut = bulkCutoff(t, d, new Set(['2026-01']), now);
  assert.equal(cut, '2027-01-01');
  const plan = applyBulkTerms([], '2026-01-01', { billing: 'MONTHLY' }, cut);
  assert.deepEqual(plan, [{ from: '2026-01-01', to: '2026-12-31' }, { from: '2027-01-01', billing: 'MONTHLY' }]);
  const dev = { ...d, plan };
  // ništa od veljače do rujna ne postaje ponovno za izdati
  assert.deepEqual(pendingInstallments(t, [dev], cover('a', ['2026-01']), now), []);
  assert.deepEqual(pendingInstallments(t, [dev], cover('a', ['2026-01']), '2027-02-05').map((p) => [p.period, p.amount]), [['2027-01', 10], ['2027-02', 10]]);
});

test('sezonski → cijela godina: prošli zimski mjeseci se ne otvaraju', () => {
  const t = terms({ startDate: '2025-04-01' });
  const d: ContractDevice = { itemId: 'a', monthly: 10, plan: [{ from: '2025-04-01', seasonFrom: 4, seasonTo: 10 }] };
  const billed = ['2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  const now = '2026-09-25';
  const cut = bulkCutoff(t, d, new Set(billed), now);
  assert.equal(cut, '2026-10-01');
  const plan = applyBulkTerms(d.plan, '2025-04-01', { season: 'year' }, cut);
  assert.deepEqual(plan, [
    { from: '2025-04-01', to: '2026-09-30', seasonFrom: 4, seasonTo: 10 },
    { from: '2026-10-01', seasonFrom: 0, seasonTo: 0 },
  ]);
  const dev = { ...d, plan };
  assert.deepEqual(pendingInstallments(t, [dev], cover('a', billed), now), []);
  assert.deepEqual(pendingInstallments(t, [dev], cover('a', billed), '2026-12-15').map((p) => p.period), ['2026-10', '2026-11', '2026-12']);
});

test('bulkCutoff: ne prije tekućeg mjeseca; neizdana ranija rata ostaje cijela; unaprijed plaćeno pomiče granicu', () => {
  const now = '2026-09-25';
  // ništa izdano: granica je tekući mjesec, prošle neizdane mjesečne rate ostaju po starom
  assert.equal(bulkCutoff(terms({}), { itemId: 'a', monthly: 10 }, new Set(), now), '2026-09-01');
  // kvartalna rata iz srpnja (neizdana) pokriva i rujan → granica listopad
  assert.equal(bulkCutoff(terms({ billing: 'QUARTERLY' }), { itemId: 'a', monthly: 10 }, new Set(), now), '2026-10-01');
  // preskočena (izdana izvan programa) godišnja rata za 2027. → granica 2028.
  assert.equal(bulkCutoff(terms({ billing: 'ANNUAL' }), { itemId: 'a', monthly: 10, skipped: ['2026-01', '2027-01'] }, new Set(), now), '2028-01-01');
  // ugovor počinje u budućnosti: izmjena vrijedi za cijeli plan
  const future = terms({ startDate: '2026-11-01' });
  const cut = bulkCutoff(future, { itemId: 'a', monthly: 10 }, new Set(), now);
  assert.deepEqual(applyBulkTerms([], '2026-11-01', { billing: 'QUARTERLY' }, cut), [{ from: '2026-11-01', billing: 'QUARTERLY' }]);
});

test('applyBulkTerms s granicom: razdoblje bez promjene se ne dijeli, kasnija razdoblja se mijenjaju', () => {
  // „kao na ugovoru" na uređaju koji već prati ugovor — plan ostaje prazan
  assert.deepEqual(applyBulkTerms([], '2026-01-01', { season: 'contract' }, '2026-09-01'), []);
  const plan = [
    { from: '2026-01-01', billing: 'MONTHLY' as const },
    { from: '2026-06-01', billing: 'QUARTERLY' as const },
    { from: '2027-01-01', billing: 'ANNUAL' as const, price: 5 },
  ];
  assert.deepEqual(applyBulkTerms(plan, '2026-01-01', { season: 'summer' }, '2026-10-01'), [
    { from: '2026-01-01', billing: 'MONTHLY' },
    { from: '2026-06-01', billing: 'QUARTERLY', to: '2026-09-30' },
    { from: '2026-10-01', billing: 'QUARTERLY', seasonFrom: 4, seasonTo: 10 },
    { from: '2027-01-01', billing: 'ANNUAL', price: 5, seasonFrom: 4, seasonTo: 10 },
  ]);
});
