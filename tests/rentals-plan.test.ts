import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pastPeriods, planFromRows, rowsFromPlan, validatePlan, type PlanRow } from '../src/domain/plan';
import { devicePlan, type ContractTerms } from '../src/domain/billing';

const c = (over: Partial<ContractTerms> = {}): ContractTerms => ({
  status: 'ACTIVE', startDate: '2026-05-01', billing: 'MONTHLY', billingMode: 'IN_ADVANCE', ...over,
});
const row = (over: Partial<PlanRow> = {}): PlanRow => ({
  from: '2026-09-01', to: '', billing: 'MONTHLY', price: '', season: 'contract', seasonFrom: 4, seasonTo: 10, ...over,
});

test('plan iz obrasca: prazna cijena i sezona „kao ugovor" ne zapisuju se, „cijela godina" je 0', () => {
  const plan = planFromRows([row({ price: '12,50', season: 'year' }), row({ from: '2026-10-01', billing: 'QUARTERLY', season: 'custom', seasonFrom: 5, seasonTo: 9 })]);
  assert.deepEqual(plan, [
    { from: '2026-09-01', billing: 'MONTHLY', price: 12.5, seasonFrom: 0, seasonTo: 0 },
    { from: '2026-10-01', billing: 'QUARTERLY', seasonFrom: 5, seasonTo: 9 },
  ]);
  // sezona 0 poništava sezonu ugovora
  assert.equal(devicePlan(c({ seasonFrom: 4, seasonTo: 10 }), { itemId: 'a', monthly: 10, plan })[0].season, null);
  assert.deepEqual(rowsFromPlan(plan).map((r) => [r.price, r.season]), [['12,5', 'year'], ['', 'custom']]);
});

test('provjera plana', () => {
  assert.equal(validatePlan([{ from: '2026-09-01', billing: 'MONTHLY' }]), null);
  assert.match(validatePlan([{ from: '', billing: 'MONTHLY' }])!, /od/);
  assert.match(validatePlan([{ from: '2026-09-01', to: '2026-08-01' }])!, /prije/);
  assert.match(validatePlan([{ from: '2026-09-01' }, { from: '2026-09-01' }])!, /istog dana/);
  assert.match(validatePlan([{ from: '2026-09-01', price: -1 }])!, /negativna/);
});

test('prošla razdoblja za naknadno dodan uređaj', () => {
  // mjesečno od svibnja, danas 23.9. → svibanj–rujan
  assert.deepEqual(pastPeriods(c(), { itemId: 'a', monthly: 10 }, '2026-09-23'), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  // unatrag: rujan se fakturira tek u listopadu
  assert.deepEqual(pastPeriods(c({ billingMode: 'IN_ARREARS' }), { itemId: 'a', monthly: 10 }, '2026-09-23'), ['2026-05', '2026-06', '2026-07', '2026-08']);
  // kvartalno i pauziran ugovor — prošlost se i dalje računa
  assert.deepEqual(pastPeriods(c({ billing: 'QUARTERLY', status: 'PAUSED' }), { itemId: 'a', monthly: 10 }, '2026-09-23'), ['2026-05', '2026-08']);
});
