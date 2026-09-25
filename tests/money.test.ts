import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, round } from '../src/domain/money';
import { documentTotals, lineShareOfNet, paymentState, openAmount } from '../src/domain/invoice';
import { priceFromMargin, suggestedRent } from '../src/domain/pricing';
import { customerVat, isValidOib } from '../src/domain/tax';
import { expandExpense } from '../src/domain/expenses';
import { addMonths, monthsBetween } from '../src/domain/dates';
import { hub3Text } from '../src/domain/hub3';

test('zaokruživanje i čitanje brojeva', () => {
  assert.equal(round(1.005), 1.01);
  assert.equal(round(-2.675), -2.68);
  assert.equal(parseNumber('1.500,00'), 1500);
  assert.equal(parseNumber('220.85'), 220.85);
  assert.equal(parseNumber('1.500.000'), 1500000);
  assert.equal(parseNumber('12,5'), 12.5);
  // hrvatski zapis: jedna točka + točno tri znamenke = tisućice
  assert.equal(parseNumber('1.500'), 1500);
  assert.equal(parseNumber('12.345'), 12345);
  assert.equal(parseNumber('-1.500'), -1500);
  assert.equal(parseNumber('1.5'), 1.5);
  assert.equal(parseNumber('1.50'), 1.5);
  assert.equal(parseNumber('0.500'), 0.5, 'vodeća nula — decimalna točka');
  assert.equal(parseNumber('1500.000'), 1500, 'više od tri znamenke ispred — decimalna točka');
  assert.equal(parseNumber('1.500,5'), 1500.5);
  assert.equal(parseNumber('1.500 €'), 1500);
});

test('zbrojevi dokumenta s popustima i naknadama', () => {
  const t = documentTotals({
    lines: [{ qty: 2, unitPrice: 100, discountPct: 10 }, { qty: 1, unitPrice: 50 }],
    vatRate: 25, discountPct: 10, discountAmount: 5, charges: [{ kind: 'N', amount: 2 }],
  });
  assert.equal(t.linesNet, 230);
  assert.equal(t.discount, 28);
  assert.equal(t.net, 202);
  assert.equal(t.vat, 50.5);
  assert.equal(t.total, 254.5);
  assert.equal(lineShareOfNet(t, 0), 158.09);
});

test('storno: popust zadržava predznak', () => {
  const t = documentTotals({ lines: [{ qty: -1, unitPrice: 100 }], vatRate: 25, discountPct: 10 });
  assert.equal(t.net, -90);
  assert.equal(t.total, -112.5);
});

test('stanje naplate', () => {
  const base = { status: 'ISSUED' as const, kind: 'INVOICE' as const, stornoed: false, date: '2026-01-01', total: 100 };
  assert.equal(paymentState({ ...base, paid: 0, open: 100 }, 30, '2026-01-10').key, 'open');
  assert.equal(paymentState({ ...base, paid: 0, open: 100 }, 30, '2026-03-10').key, 'overdue');
  assert.equal(paymentState({ ...base, dueDate: '2026-01-15', paid: 0, open: 100 }, 30, '2026-01-20').key, 'overdue');
  assert.equal(paymentState({ ...base, paid: 40, open: 60 }, 30, '2026-01-10').label, 'Djelomično (40 %)');
  const paid = paymentState({ ...base, paid: 100, open: 0, lastPaymentDate: '2026-01-21' }, 30, '2026-05-01');
  assert.deepEqual([paid.key, paid.days], ['paid', 20]);
  assert.equal(openAmount({ kind: 'STORNO', stornoed: false, total: -100, advance: 0, paid: 0 }), 0);
});

test('marže i prijedlozi cijena', () => {
  assert.equal(priceFromMargin(100, 35), 153.85);
  assert.deepEqual(suggestedRent({ cost: 1000, fallbackPct: 5.5 }), { price: 55, source: 'cost' });
  assert.deepEqual(suggestedRent({ agreed: 30, modelRent: 40, cost: 1000, fallbackPct: 5.5 }), { price: 30, source: 'agreed' });
});

test('PDV prema državi kupca i OIB', () => {
  const co = { vatRegistered: true, vatRate: 25, country: 'HR' };
  assert.equal(customerVat('HR', co).rate, 25);
  assert.equal(customerVat('SI', co).category, 'K');
  assert.equal(customerVat('US', co).category, 'G');
  assert.ok(isValidOib('69435151530'));
  assert.ok(!isValidOib('12345678901'));
});

test('ponavljajući trošak staje na danas i poštuje izmjene', () => {
  const occ = expandExpense(
    { id: 'e', date: '2026-01-15', netAmount: 10, vatAmount: 2.5, frequency: 'MONTHLY', overrides: { '2026-02': { skipped: true }, '2026-03': { amount: 20 } } },
    '2026-01-01', '2026-12-31', '2026-04-20',
  );
  assert.deepEqual(occ.map((o) => [o.period, o.netAmount, o.vatAmount]), [['2026-01', 10, 2.5], ['2026-03', 20, 5], ['2026-04', 10, 2.5]]);
});

test('datumi', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(monthsBetween('2026-09-01', '2026-11-30'), 3);
});

test('HUB3 ima 14 redaka i iznos u centima', () => {
  const t = hub3Text({ amount: 368.75, payer: { name: 'Kupac' }, payee: { name: 'Firma' }, iban: 'HR12 1001 0051 8630 0016 0', reference: '12-2026' });
  const rows = t.split('\n');
  assert.equal(rows.length, 14);
  assert.equal(rows[2], '000000000036875');
  assert.equal(rows[9], 'HR1210010051863000160');
});
