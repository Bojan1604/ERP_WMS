/** Područje C (QA t6 brzina): izračun rata s preskakanjem starih razdoblja i jednim izračunom za jednake uređaje daje iste rate. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingInstallments, scheduledCharges, type BillingCode, type ContractDevice, type ContractTerms } from '../src/domain/billing';

const terms = (t: Partial<ContractTerms> = {}): ContractTerms => ({
  status: 'ACTIVE', startDate: '2015-03-17', billing: 'MONTHLY', billingMode: 'IN_ADVANCE', ...t,
});

test('scheduledCharges od kasnijeg razdoblja = isti raspored kao korak po korak od početka', () => {
  for (const billing of ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ONCE'] as BillingCode[]) {
    for (const t of [terms({ billing }), terms({ billing, seasonFrom: 11, seasonTo: 2 }), terms({ billing, endDate: '2026-05-10' })]) {
      const d: ContractDevice = { itemId: 'a', monthly: 12.5, plan: [{}, { from: '2024-02-10', billing: 'QUARTERLY', price: 7 }] };
      const all = scheduledCharges(t, d, '2000-01', '2030-12');
      for (const from of ['2014-01', '2015-03', '2015-04', '2024-01', '2024-03', '2026-02', '2029-01']) {
        assert.deepEqual(scheduledCharges(t, d, from, '2027-06'), all.filter((c) => c.period >= from && c.period <= '2027-06'), `${billing} od ${from}`);
      }
    }
  }
});

test('jednaki uređaji računaju se jednom, a preskočena i fakturirana razdoblja ostaju po uređaju', () => {
  const t = terms({ startDate: '2026-01-01' });
  const plan = [{ from: '2026-01-01', billing: 'MONTHLY' as BillingCode }];
  const devices: ContractDevice[] = [
    { itemId: 'a', monthly: 10, plan, skipped: ['2026-02'] },
    { itemId: 'b', monthly: 10, plan, skipped: [] },
    { itemId: 'c', monthly: 10, plan, paused: ['2026-03'] },
    // isti uređaj među skinutima: rata samo jednom
    { itemId: 'b', monthly: 10, plan, endDate: '2026-02-20' },
  ];
  const rows = pendingInstallments(t, devices, new Set(['b|2026-01']), '2026-03-15');
  assert.deepEqual(
    rows.map((r) => [r.period, r.amount, r.lines.map((l) => l.itemId)]),
    [
      ['2026-01', 20, ['a', 'c']],
      ['2026-02', 20, ['b', 'c']],
      ['2026-03', 20, ['a', 'b']],
    ],
  );
});
