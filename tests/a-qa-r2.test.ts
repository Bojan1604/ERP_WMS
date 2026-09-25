/** QA prodaja, krug 2 (t1): predujam ≤ račun (N1), predlošci e-pošte (N3), spremnost fiskalizacije (N4), množina, razdoblje rate. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampAdvanceUses } from '../src/domain/invoice';
import { buildUbl, type UblInput } from '../src/domain/ubl';
import { invoiceMailTemplate, MAIL_DEFAULTS, fillTemplate } from '../src/domain/mail';
import { fiscalReadiness } from '../src/domain/fiscal';
import { plural } from '../src/domain/plural';
import { periodSpanLabel } from '../src/domain/dates';

test('N1: uračunati predujmovi se ograničavaju na iznos računa (od zadnjeg)', () => {
  const uses = [
    { advanceId: 'a', amount: 100 },
    { advanceId: 'b', amount: 400 },
  ];
  assert.deepEqual(clampAdvanceUses(uses, 125), [
    { advanceId: 'a', amount: 100 },
    { advanceId: 'b', amount: 25 },
  ]);
  assert.deepEqual(clampAdvanceUses(uses, 600), uses);
  assert.deepEqual(clampAdvanceUses(uses, -10).map((u) => u.amount), [0, 0]);
});

test('N1: UBL — PrepaidAmount najviše do ukupnog, PayableAmount = ukupno − predujam ≥ 0 (BR-CO-16)', () => {
  const input: UblInput = {
    kind: 'INVOICE',
    type: 'SERVICE',
    number: '5/PP1/1',
    issueDate: '2026-09-01',
    issueTime: '10:00:00',
    seller: { name: 'F', oib: '12345678903', address: 'A', zip: '10000', city: 'Zagreb', country: 'HR', iban: 'HR1210010051863000160', vatRegistered: true },
    operator: { name: 'Ana', oib: '12345678903' },
    buyer: { name: 'K', oib: '69435151530', address: 'B', zip: '21000', city: 'Split', country: 'HR' },
    vatRate: 25,
    taxCategory: 'S',
    advanceAmount: 500,
    lines: [{ description: 'Usluga', kpd: '62.09.20', unit: 'kom', qty: 1, unitPrice: 100 }],
  };
  const { xml, totals } = buildUbl(input);
  assert.equal(totals.total, 125);
  assert.equal(totals.prepaid, 125);
  assert.equal(totals.payable, 0);
  assert.match(xml, /<cbc:PrepaidAmount currencyID="EUR">125\.00<\/cbc:PrepaidAmount>/);
  assert.match(xml, /<cbc:PayableAmount currencyID="EUR">0\.00<\/cbc:PayableAmount>/);
});

test('N3: predložak e-pošte prema vrsti i stanju računa', () => {
  const base = { stornoed: false, advance: 0 };
  assert.deepEqual(invoiceMailTemplate({ ...base, kind: 'INVOICE', total: 125, open: 125 }), { template: 'invoice', amount: 125 });
  assert.deepEqual(invoiceMailTemplate({ ...base, kind: 'INVOICE', total: 125, open: 25 }), { template: 'invoice', amount: 25 });
  // plaćen: ne „Iznos za platiti: 100,00"
  assert.deepEqual(invoiceMailTemplate({ ...base, kind: 'INVOICE', total: 125, open: 0 }), { template: 'invoicePaid', amount: 125 });
  assert.deepEqual(invoiceMailTemplate({ stornoed: false, kind: 'INVOICE', total: 125, advance: 25, open: 0 }), { template: 'invoicePaid', amount: 100 });
  // odobrenje: ne „Račun…" ni negativni iznos za platiti
  assert.deepEqual(invoiceMailTemplate({ ...base, kind: 'CREDIT_NOTE', total: -50, open: 0 }), { template: 'creditNote', amount: 50 });
  assert.deepEqual(invoiceMailTemplate({ ...base, kind: 'STORNO', total: -125, open: 0 }), { template: 'storno', amount: 125 });
  assert.deepEqual(invoiceMailTemplate({ ...base, kind: 'ADVANCE', total: 125, open: 0 }), { template: 'advance', amount: 125 });
  const t = MAIL_DEFAULTS.creditNote;
  assert.equal(fillTemplate(t.subject, { broj: '3-A1-1' }), 'Knjižno odobrenje 3-A1-1');
  assert.doesNotMatch(t.body, /za platiti|rok/i);
  assert.match(MAIL_DEFAULTS.invoicePaid.body, /plaćen/);
  assert.doesNotMatch(MAIL_DEFAULTS.invoicePaid.body, /za platiti/);
});

test('N4: spremnost fiskalizacije — zadani operater firme pokriva korisnike bez OIB-a', () => {
  const company = { oib: '12345678903', fiscalEnabled: true, fiscalEnv: 'TEST', invoicePremises: 'PP1', invoiceDevice: '1', eInvoiceProvider: 'none', hasApiKey: false, cert: null };
  const operators = [{ name: 'Ana', oib: null }];
  const without = fiscalReadiness({ company, operators }).find((x) => x.key === 'operators')!;
  assert.equal(without.ok, false);
  const withDefault = fiscalReadiness({ company: { ...company, operatorOib: '69435151530', operatorName: 'Ivo Ivić' }, operators }).find((x) => x.key === 'operators')!;
  assert.equal(withDefault.ok, true);
  assert.match(withDefault.hint ?? '', /Zadani operater: Ivo Ivić/);
  assert.match(withDefault.hint ?? '', /Ana/);
  // neispravan zadani OIB ne vrijedi
  assert.equal(fiscalReadiness({ company: { ...company, operatorOib: '123' }, operators }).find((x) => x.key === 'operators')!.ok, false);
});

test('množina: 1 stavka, 3 stavke, 5 stavki, 11–14, 21, 22', () => {
  const s = (n: number) => `${n} ${plural(n, 'stavka', 'stavke', 'stavki')}`;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 25, 101, 112].map(s), [
    '0 stavki', '1 stavka', '2 stavke', '3 stavke', '4 stavke', '5 stavki', '11 stavki', '12 stavki', '14 stavki', '21 stavka', '22 stavke', '25 stavki', '101 stavka', '112 stavki',
  ]);
});

test('opis rate: razdoblje prema broju mjeseci (kvartalna, preko godine)', () => {
  assert.equal(periodSpanLabel('2026-09', 1), 'rujan 2026.');
  assert.equal(periodSpanLabel('2026-09', 3), 'rujan – studeni 2026.');
  assert.equal(periodSpanLabel('2026-12', 3), 'prosinac 2026. – veljača 2027.');
  assert.equal(periodSpanLabel('2026-01', 12), 'siječanj – prosinac 2026.');
});
