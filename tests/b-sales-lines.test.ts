import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billingFromMonths,
  defaultKpd,
  effectiveLineType,
  einvoiceFilterValues,
  hasRentLines,
  kpdValid,
  monthsOfBilling,
  proformaReference,
  providerStatus,
} from '../src/domain/sales-lines';

const company = { kpdSale: '26.20.11', kpdRent: '77.33.01', kpdService: '62.90.10' };

test('vrsta stavke: vlastita ili vrsta računa; najam na miješanom računu', () => {
  assert.equal(effectiveLineType(null, 'SALE'), 'SALE');
  assert.equal(effectiveLineType('RENT', 'SALE'), 'RENT');
  assert.equal(effectiveLineType(undefined, 'RENT'), 'RENT');
  assert.equal(effectiveLineType('SALE', 'RENT'), 'SALE');
  assert.ok(hasRentLines('SALE', [{ lineType: null }, { lineType: 'RENT' }]));
  assert.ok(!hasRentLines('SALE', [{ lineType: null }]));
  assert.ok(hasRentLines('RENT', []));
});

test('učestalost iz broja mjeseci i obrnuto', () => {
  assert.equal(billingFromMonths(3), 'QUARTERLY');
  assert.equal(billingFromMonths(12), 'ANNUAL');
  assert.equal(billingFromMonths(null), 'MONTHLY');
  assert.equal(monthsOfBilling('SEMIANNUAL'), 6);
  assert.equal(monthsOfBilling('ONCE'), 1);
});

test('KPD: oblik NN.NN.NN i zadane šifre po vrsti stavke', () => {
  assert.ok(kpdValid('26.20.11'));
  assert.ok(!kpdValid('26.2.11'));
  assert.ok(!kpdValid(''));
  assert.equal(defaultKpd({ lineType: 'SALE', kind: 'DEVICE', modelKpd: '26.20.16', company }), '26.20.16');
  assert.equal(defaultKpd({ lineType: 'SALE', kind: 'DEVICE', company }), '26.20.11');
  assert.equal(defaultKpd({ lineType: 'RENT', kind: 'DEVICE', modelKpd: '26.20.16', modelKpdRent: '77.33.02', company }), '77.33.02');
  assert.equal(defaultKpd({ lineType: 'RENT', kind: 'DEVICE', modelKpd: '26.20.16', company }), '77.33.01');
  // najam bez KPD-a za najam (model i firma) ne uzima KPD robe s modela
  assert.equal(defaultKpd({ lineType: 'RENT', kind: 'DEVICE', modelKpd: '26.20.16', company: {} }), null);
  assert.equal(defaultKpd({ lineType: 'SALE', kind: 'SERVICE', serviceKpd: null, company }), '62.90.10');
  assert.equal(defaultKpd({ lineType: 'SALE', kind: 'SERVICE', serviceKpd: '95.10.01', company }), '95.10.01');
  assert.equal(defaultKpd({ lineType: 'SERVICE', kind: 'MANUAL', company }), '62.90.10');
  assert.equal(defaultKpd({ lineType: 'SALE', kind: 'MANUAL', company: {} }), null);
});

test('eRačun: stanje posrednika → stanje za popis', () => {
  assert.equal(providerStatus({ status: 'DELIVERED' }).code, 'DELIVERED');
  assert.equal(providerStatus({ businessStatus: 6 }).code, 'REJECTED');
  assert.equal(providerStatus({ businessStatus: '8' }).code, 'PAID');
  assert.equal(providerStatus({ businessStatus: 7 }).code, 'ACCEPTED');
  assert.equal(providerStatus({ transportStatus: 'Poslan' }).code, 'SENT');
  assert.equal(providerStatus({ transportStatus: 'Dostavljen', businessStatus: 5 }).code, 'ACCEPTED');
  assert.match(providerStatus({ transportStatus: 'Dostavljen', businessStatus: 5 }).text, /Dostavljen · prihvaćen/);
  assert.equal(providerStatus('OK').code, 'SENT');
  assert.deepEqual(einvoiceFilterValues(['none', 'DELIVERED']), { values: ['DELIVERED', 'ACCEPTED'], none: true });
});

test('poziv na broj predračuna', () => {
  assert.equal(proformaReference('PRED-2026-0007'), '7-2026');
  assert.equal(proformaReference('PRED-2026-0120'), '120-2026');
});
