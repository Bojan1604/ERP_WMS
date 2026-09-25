/**
 * Područje E — čista logika: stupci popisa uređaja, jamstvo u danima, pravila
 * brisanja, OCR tokeni, pravilo „trošak robe jednom" i odluke po retku zahtjeva.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableColumns, deleteBlockedMessage, deleteBlocker, looksLikeSerial, ocrTokens, ocrVariants, visibleColumns, warrantyDaysLeft,
} from '../src/domain/warehouse-list';
import { csvSafeText, toCsv } from '../src/lib/csv';
import {
  PURCHASE_CATEGORY, allocateGoodsExpense, defaultGoodsInvoice, goodsExpenseTotal, matchesGoodsAmount, receiptBooksExpense, receiptEffect, vatPctOf, type GoodsInvoiceRow,
} from '../src/domain/purchase-links';
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

test('trošak robe: max(primke, računi za robu), nikad zbroj', () => {
  const inv = (id: string, net: number, over: Partial<GoodsInvoiceRow> = {}): GoodsInvoiceRow => ({ id, net, vat: net * 0.25, goods: true, books: true, ...over });
  // račun za robu u cijelosti pokriven primkom
  assert.deepEqual(allocateGoodsExpense(200, [inv('a', 200)]), [{ id: 'a', covered: 200, ownNet: 0, ownVat: 0, mode: 'receipt' }]);
  // bez primke račun knjiži cijelu osnovicu
  assert.equal(allocateGoodsExpense(0, [inv('a', 200)])[0].mode, 'own');
  // dva djelomična računa (100 + 100) i primka 200 → 200, ne 400
  assert.equal(goodsExpenseTotal(200, [inv('a', 100), inv('b', 100)]), 200);
  // račun viši od primke knjiži samo razliku (PDV razmjerno)
  assert.deepEqual(allocateGoodsExpense(200, [inv('a', 250)])[0], { id: 'a', covered: 200, ownNet: 50, ownVat: 12.5, mode: 'partial' });
  assert.equal(goodsExpenseTotal(200, [inv('a', 250)]), 250);
  // primka viša od računa: trošak = primka
  assert.equal(goodsExpenseTotal(300, [inv('a', 100)]), 300);
  // prijevoz (nije roba) uvijek zaseban trošak i ne troši primku
  const freight = inv('f', 25, { goods: false });
  const al = allocateGoodsExpense(200, [freight, inv('a', 200)]);
  assert.deepEqual(al.map((x) => [x.mode, x.ownNet]), [['own', 25], ['receipt', 0]]);
  // neknjiženi / zaprimljeni / odbijeni račun ne knjiži i ne troši primku
  assert.deepEqual(allocateGoodsExpense(100, [inv('x', 100, { books: false }), inv('a', 150)]).map((x) => x.ownNet), [0, 50]);
  // odobrenje (negativna osnovica) ne troši primku
  assert.equal(allocateGoodsExpense(100, [inv('c', -50)])[0].ownNet, -50);
  // dijalog zaprimanja: primka 200 uz račun za robu 200 bez primke → račun se umanjuje za 200, ukupno ne raste
  assert.deepEqual(receiptEffect(0, [inv('a', 200)], 200), { invoiceReduced: 200, totalIncrease: 0 });
  assert.deepEqual(receiptEffect(0, [inv('a', 100)], 200), { invoiceReduced: 100, totalIncrease: 100 });
  assert.deepEqual(receiptEffect(0, [], 200), { invoiceReduced: 0, totalIncrease: 200 });

  assert.equal(matchesGoodsAmount(1000, [1009, 0]), true);
  assert.equal(matchesGoodsAmount(1000, [1011]), false);
  assert.equal(matchesGoodsAmount(50, [50.9]), true, 'do 1 € razlike kod malih iznosa');
  assert.equal(matchesGoodsAmount(60, [0, 0]), false);
  assert.equal(defaultGoodsInvoice({ net: 200, refs: [200, 500], otherGoodsInvoices: 0 }), true);
  assert.equal(defaultGoodsInvoice({ net: 200, refs: [200], otherGoodsInvoices: 1 }), false, 'drugi račun bez kategorije nije zadano račun za robu');
  assert.equal(defaultGoodsInvoice({ net: 30, refs: [200, 500], otherGoodsInvoices: 0 }), false, 'prijevoz bez kategorije');
  // djelomični računi kategorije „Nabava robe" do nefakturirane vrijednosti
  assert.equal(defaultGoodsInvoice({ net: 100, category: PURCHASE_CATEGORY, refs: [0, 200], otherGoodsInvoices: 0 }), true);
  assert.equal(defaultGoodsInvoice({ net: 100, category: PURCHASE_CATEGORY, refs: [0, 200], otherGoodsNet: 100, otherGoodsInvoices: 1 }), true);
  assert.equal(defaultGoodsInvoice({ net: 100, category: PURCHASE_CATEGORY, refs: [200, 200], otherGoodsNet: 200, otherGoodsInvoices: 1 }), false, 'roba je već fakturirana');
  assert.equal(defaultGoodsInvoice({ net: 200, category: 'Prijevoz', refs: [200, 200], otherGoodsInvoices: 0 }), false, 'druga kategorija nije roba');
  assert.equal(defaultGoodsInvoice({ net: 0, category: PURCHASE_CATEGORY, refs: [200], otherGoodsInvoices: 0 }), false);
  assert.equal(receiptBooksExpense({ bookExpense: true, total: 100 }), true);
  assert.equal(receiptBooksExpense({ bookExpense: false, total: 100 }), false);
  assert.equal(receiptBooksExpense({ bookExpense: true, total: 0 }), false);
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

test('CSV: tekst koji Excel čita kao formulu dobiva apostrof; brojevi ostaju', () => {
  const csv = toCsv(
    [{ a: '=HYPERLINK("http://x")', b: '+1+2', c: '@SUM(A1)', d: '-12,50', e: 'obično', f: -5, g: '\tx' }],
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => ({ label: k, value: (r: Record<string, string | number>) => r[k] })),
  );
  const row = csv.split('\r\n')[1];
  assert.equal(row, `"'=HYPERLINK(""http://x"")";'+1+2;'@SUM(A1);-12,50;obično;-5;'\tx`);
  assert.equal(csvSafeText('-A1+B1'), "'-A1+B1");
});
