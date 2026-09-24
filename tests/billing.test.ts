import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contractBilling, contractAccrual, deviceCharges, devicePlan, installmentDate, nextBillingDate,
  pendingInstallments, planSummary, returnReason, scheduledCharges, type ContractTerms, type ContractDevice,
} from '../src/domain/billing';

const c = (over: Partial<ContractTerms> = {}): ContractTerms => ({
  status: 'ACTIVE', startDate: '2026-06-01', billing: 'MONTHLY', billingMode: 'IN_ADVANCE', ...over,
});
const d = (over: Partial<ContractDevice> = {}): ContractDevice => ({ itemId: 'a', monthly: 20, ...over });

test('kvartalna naplata: rata je 3 × mjesečna, obračun je mjesečni', () => {
  const k = c({ billing: 'QUARTERLY', startDate: '2026-01-01' });
  assert.deepEqual(contractBilling(k, [d()], 2026), [60, 0, 0, 60, 0, 0, 60, 0, 0, 60, 0, 0]);
  assert.deepEqual(contractAccrual(k, [d()], 2026), Array(12).fill(20));
});

test('plan: jednokratno u rujnu, kvartalno od listopada', () => {
  const plan = [
    { from: '2026-09-01', to: '2026-09-30', billing: 'ONCE' as const },
    { from: '2026-10-01', billing: 'QUARTERLY' as const },
  ];
  const ch = deviceCharges(c({ startDate: '2026-09-01' }), d({ plan }), '2026-01', '2027-06');
  assert.deepEqual(ch.map((x) => [x.period, x.amount]), [['2026-09', 20], ['2026-10', 60], ['2027-01', 60], ['2027-04', 60]]);
  assert.equal(planSummary(c(), d({ plan })), 'jednokratno → kvartalno od 01.10.2026.');
});

test('razdoblje završava dan prije sljedećeg i na kraju ugovora', () => {
  const plan = devicePlan(c({ endDate: '2026-12-31' }), d({ plan: [{ from: '2026-06-01' }, { from: '2026-09-01', price: 30 }] }));
  assert.equal(plan[0].to, '2026-08-31');
  assert.equal(plan[1].to, '2026-12-31');
  assert.equal(plan[1].price, 30);
});

test('sezona preko prijeloma godine', () => {
  const k = c({ startDate: '2026-01-01', seasonFrom: 11, seasonTo: 2 });
  assert.deepEqual(contractBilling(k, [d()], 2026), [20, 20, 0, 0, 0, 0, 0, 0, 0, 0, 20, 20]);
});

test('unatrag: rata za svibanj izdaje se u lipnju', () => {
  assert.equal(installmentDate(c({ billingMode: 'IN_ARREARS', startDate: '2026-05-01' }), '2026-05'), '2026-06-01');
  assert.equal(installmentDate(c({ startDate: '2026-05-18', firstBillingDate: '2026-06-01', billingDay: 5 }), '2026-06'), '2026-06-01');
  assert.equal(installmentDate(c({ startDate: '2026-05-18', firstBillingDate: '2026-06-01', billingDay: 5 }), '2026-07'), '2026-07-05');
  assert.equal(installmentDate(c({ startDate: '2026-01-31' }), '2026-02'), '2026-02-28');
});

test('rate za izdati: tri neizdane rate, pokrivena po uređaju', () => {
  const pending = pendingInstallments(c(), [d(), d({ itemId: 'b', monthly: 10 })], new Set(['a|2026-07']), '2026-08-29');
  assert.deepEqual(pending.map((p) => [p.period, p.amount, p.lines.length]), [['2026-06', 30, 2], ['2026-07', 10, 1], ['2026-08', 30, 2]]);
});

test('preskočena razdoblja i pauzirani uređaj se ne traže', () => {
  const pending = pendingInstallments(c(), [d({ skipped: ['2026-06'] }), d({ itemId: 'b', status: 'PAUSED' })], new Set(), '2026-07-02');
  assert.deepEqual(pending.map((p) => p.period), ['2026-07']);
});

test('neaktivan ugovor nema rata; sljedeća naplata', () => {
  assert.equal(pendingInstallments(c({ status: 'TERMINATED' }), [d()], new Set(), '2026-08-01').length, 0);
  assert.equal(nextBillingDate(c({ billing: 'QUARTERLY' }), [d()], '2026-07-15'), '2026-09-01');
});

test('razlog povrata', () => {
  assert.equal(returnReason(c({ endDate: '2026-07-01' }), d(), '2026-08-01'), 'Ugovor istekao');
  assert.equal(returnReason(c({ seasonFrom: 5, seasonTo: 9 }), d(), '2026-10-10'), 'Sezona završila');
  assert.equal(returnReason(c(), d(), '2026-10-10'), null);
});

test('razdoblje iza kraja ugovora se ne naplaćuje', () => {
  const k = c({ startDate: '2026-01-01', endDate: '2026-06-30' });
  const ch = deviceCharges(k, d({ monthly: 10, plan: [{ from: '2026-01-01' }, { from: '2026-09-01', billing: 'ONCE' }] }), '2026-01', '2026-12');
  assert.deepEqual(ch.map((x) => x.period), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
});

test('pauza naplate: pauzirani mjesec se ne naplaćuje, ne traži račun i ne ulazi u obračun', () => {
  const k = c({ startDate: '2026-01-01', billing: 'MONTHLY' });
  const d: ContractDevice = { itemId: 'a', monthly: 20, paused: ['2026-03'] };
  const periods = deviceCharges(k, d, '2026-01', '2026-05').map((x) => x.period);
  assert.deepEqual(periods, ['2026-01', '2026-02', '2026-04', '2026-05']);
  assert.equal(scheduledCharges(k, d, '2026-01', '2026-05').length, 5, 'raspored i dalje zna za pauzirani mjesec');
  const pend = pendingInstallments(k, [d, { itemId: 'b', monthly: 10 }], new Set(), '2026-05-15');
  const march = pend.find((p) => p.period === '2026-03')!;
  assert.deepEqual(march.lines.map((l) => l.itemId), ['b'], 'u ožujku se naplaćuje samo drugi uređaj');
  assert.equal(march.amount, 10);
  const acc = contractAccrual(k, [d], 2026);
  assert.equal(acc[1], 20);
  assert.equal(acc[2], 0);
});

test('pauza kvartalne rate pokriva sva tri mjeseca obračuna', () => {
  const k = c({ startDate: '2026-01-01', billing: 'QUARTERLY' });
  const d: ContractDevice = { itemId: 'a', monthly: 10, paused: ['2026-04'] };
  assert.deepEqual(deviceCharges(k, d, '2026-01', '2026-12').map((x) => x.period), ['2026-01', '2026-07', '2026-10']);
  const acc = contractAccrual(k, [d], 2026);
  assert.deepEqual(acc.slice(3, 6), [0, 0, 0]);
  assert.equal(acc[2], 10);
  assert.equal(acc[6], 10);
});
