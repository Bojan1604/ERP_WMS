/**
 * Područje E — čista logika: stupci popisa uređaja, jamstvo u danima, pravila
 * brisanja, OCR tokeni, pravilo „trošak robe jednom" i odluke po retku zahtjeva.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableColumns, deleteBlockedMessage, deleteBlocker, looksLikeSerial, ocrTokens, ocrVariants, visibleColumns, warrantyDaysLeft,
} from '../src/domain/warehouse-list';
import { invoiceExpenseMode, receiptBooksExpense, vatPctOf } from '../src/domain/purchase-links';
import { planReceiveRows } from '../src/domain/receive-request';
import { accountantEInvoiceLabel } from '../src/domain/accountant';

test('stupci: bez prava na nabavne cijene nema stupca nabavne; zapamćeni izbor se čisti', () => {
  assert.ok(availableColumns(true).some((c) => c.key === 'cost'));
  assert.ok(!availableColumns(false).some((c) => c.key === 'cost'));
  assert.ok(visibleColumns(null, true).has('status'));
  assert.ok(!visibleColumns(null, true).has('cpu'), 'procesor je zadano skriven');
  assert.deepEqual([...visibleColumns(['cpu', 'cost', 'nepostojeci'], false)], ['cpu']);
  assert.deepEqual([...visibleColumns('smeće', true)].length > 0, true);
});

test('jamstvo: preostali dani od početka + mjeseci; isteklo je negativno; bez početka null', () => {
  assert.equal(warrantyDaysLeft('2026-01-01', 12, '2026-12-31'), 1);
  assert.equal(warrantyDaysLeft('2024-01-01', 12, '2026-01-01'), -365);
  assert.equal(warrantyDaysLeft(null, 12), null);
  assert.equal(warrantyDaysLeft('2026-01-01', 0), null);
});

test('brisanje: razlozi blokade i skupna poruka', () => {
  const free = { serial: 'A', invoiceId: null, invoiceLines: 0, onContract: false, returnedFromContract: 0, transfers: 0, serviceOrders: 0 };
  assert.equal(deleteBlocker(free), null);
  assert.equal(deleteBlocker({ ...free, invoiceLines: 1 }), 'na računu');
  assert.equal(deleteBlocker({ ...free, returnedFromContract: 1 }), 'na ugovoru o najmu');
  assert.equal(deleteBlocker({ ...free, transfers: 2 }), 'na međuskladišnici');
  assert.equal(deleteBlocker({ ...free, serviceOrders: 1 }), 'ima servisni nalog');
  assert.equal(deleteBlockedMessage([free]), null);
  const msg = deleteBlockedMessage([free, { ...free, serial: 'B', invoiceId: 'x' }, { ...free, serial: 'C', onContract: true }]);
  assert.match(msg!, /na računu: B/);
  assert.match(msg!, /ugovoru o najmu: C/);
  assert.match(msg!, /otpišite/);
});

test('OCR: tokeni s naljepnice, prefiks SN, varijante slovo/znamenka', () => {
  const t = ocrTokens('Model TC21\nS/N: 21OO7B5012 PN 1234\nSN21007B5012 x');
  assert.ok(t.includes('21OO7B5012'));
  assert.ok(t.includes('21007B5012'), 'prefiks SN se skida');
  assert.ok(!t.includes('1234'), 'prekratko');
  assert.ok(ocrVariants('21OO7B5012').includes('2100785012') || ocrVariants('21OO7B5012').includes('21007B5012'));
  assert.ok(ocrVariants('21OO7B5012').includes('21007B5012'));
  assert.ok(looksLikeSerial('ABC12345'));
  assert.ok(!looksLikeSerial('ABCDEFGH'));
});

test('trošak robe se knjiži jednom', () => {
  assert.equal(invoiceExpenseMode({ book: true, rejected: false, receiptExpenses: 0 }), 'own');
  assert.equal(invoiceExpenseMode({ book: true, rejected: false, receiptExpenses: 2 }), 'receipt');
  assert.equal(invoiceExpenseMode({ book: false, rejected: false, receiptExpenses: 0 }), 'none');
  assert.equal(invoiceExpenseMode({ book: true, rejected: true, receiptExpenses: 1 }), 'none');
  assert.equal(receiptBooksExpense({ bookExpense: true, total: 100, invoiceOwnExpenses: 0 }), true);
  assert.equal(receiptBooksExpense({ bookExpense: true, total: 100, invoiceOwnExpenses: 1 }), false);
  assert.equal(receiptBooksExpense({ bookExpense: false, total: 100, invoiceOwnExpenses: 0 }), false);
  assert.equal(receiptBooksExpense({ bookExpense: true, total: 0, invoiceOwnExpenses: 0 }), false);
  assert.equal(vatPctOf(200, 50), 25);
  assert.equal(vatPctOf(0, 0), null);
});

test('zahtjev po retku: grupiranje po modelu, ispravci, preskakanje i greške', () => {
  const p = planReceiveRows(['A', 'B', 'C'], [
    { code: 'A', serial: 'A', modelId: 'm1', skip: false },
    { code: 'B', serial: ' B 2 ', modelId: 'm2', skip: false },
    { code: 'C', serial: '', modelId: null, skip: true },
  ]);
  assert.deepEqual([...p.byModel], [['m1', ['A']], ['m2', ['B2']]]);
  assert.deepEqual(p.serialFix, { B: 'B2' });
  assert.equal(p.skipped, 1);
  assert.equal(p.received, 2);
  assert.throws(() => planReceiveRows(['A'], []), /Nedostaje odluka/);
  assert.throws(() => planReceiveRows(['A'], [{ code: 'Z', serial: 'Z', modelId: 'm', skip: false }]), /nije u zahtjevu/);
  assert.throws(() => planReceiveRows(['A'], [{ code: 'A', serial: 'A', modelId: null, skip: false }]), /odaberite model/);
  assert.throws(() => planReceiveRows(['A', 'B'], [{ code: 'A', serial: 'X', modelId: 'm', skip: false }, { code: 'B', serial: 'X', modelId: 'm', skip: false }]), /više puta/);
});

test('knjigovođa: oznaka eRačuna', () => {
  assert.equal(accountantEInvoiceLabel(null), '');
  assert.equal(accountantEInvoiceLabel('INBOUND'), 'ulazni eRačun');
  assert.equal(accountantEInvoiceLabel('DELIVERED'), 'eRačun · dostavljen');
});
