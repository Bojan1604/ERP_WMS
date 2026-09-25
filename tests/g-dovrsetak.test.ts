/**
 * Dovršetak prijenosa (čista logika): paketi (raspodjela cijene, zbrojevi), plan
 * naplate računa za najam s „Zatim naplata prelazi u", naslov predračuna, PDV po
 * naplaćenoj naknadi u eRačunu i uvoz specifikacija / kategorije / paketa iz stare baze.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distributePackagePrice, packageTotals } from '../src/domain/pricing';
import { invoiceRentPlan } from '../src/domain/sales-lines';
import { quoteDocTitle } from '../src/domain/documents';
import { buildUbl, type UblInput } from '../src/domain/ubl';
import { VAT_ON_PAYMENT_NOTE } from '../src/domain/tax';
import { mapLegacy } from '../src/server/import/legacy';

test('paket: cijena se raspoređuje razmjerno preporučenim cijenama, zbroj je točno cijena paketa', () => {
  assert.deepEqual(distributePackagePrice([100, 200, 300], null), [100, 200, 300]);
  const p = distributePackagePrice([100, 200, 300], 500);
  assert.equal(p.reduce((a, b) => a + b, 0), 500);
  assert.deepEqual(p.slice(1), [166.67, 250]);
  // zaokruživanje ide na prvu stavku
  const q = distributePackagePrice([1, 1, 1], 100);
  assert.deepEqual(q, [33.34, 33.33, 33.33]);
  // bez preporučenih cijena — jednako
  assert.deepEqual(distributePackagePrice([0, 0], 99), [49.5, 49.5]);
  assert.deepEqual(distributePackagePrice([], 10), []);

  const t = packageTotals([{ cost: 100, price: 150 }, { cost: 200, price: 250 }], null);
  assert.deepEqual({ cost: t.cost, suggested: t.suggested, price: t.price, profit: t.profit }, { cost: 300, suggested: 400, price: 400, profit: 100 });
  assert.equal(t.margin, 25);
  const own = packageTotals([{ cost: 100, price: 150 }], 80);
  assert.equal(own.profit, -20);
  assert.equal(own.margin, -25);
});

test('račun za najam: plan naplate uređaja s prijelazom na drugu naplatu', () => {
  const base = { invoiceDate: '2026-09-15', contractStart: '2026-01-01', contractBilling: 'MONTHLY' as const, lineBilling: 'MONTHLY' as const };
  // uvjeti ugovora i početak — prazan plan (vrijedi ugovor)
  assert.deepEqual(invoiceRentPlan({ ...base, invoiceDate: '2025-12-01' }), []);
  // naplata od datuma računa
  assert.deepEqual(invoiceRentPlan(base), [{ from: '2026-09-15', billing: 'MONTHLY' }]);
  // „Zatim naplata prelazi u" kvartalnu od 1. 10.
  assert.deepEqual(invoiceRentPlan({ ...base, next: { billing: 'QUARTERLY', from: '2026-10-01' } }), [
    { from: '2026-09-15', billing: 'MONTHLY' },
    { from: '2026-10-01', billing: 'QUARTERLY' },
  ]);
  // prijelaz prije početka naplate se zanemaruje
  assert.deepEqual(invoiceRentPlan({ ...base, next: { billing: 'ANNUAL', from: '2026-09-15' } }), [{ from: '2026-09-15', billing: 'MONTHLY' }]);
  // početak ugovora nakon datuma računa: kreće od početka ugovora
  assert.deepEqual(invoiceRentPlan({ ...base, contractStart: '2026-10-01', next: { billing: 'ANNUAL', from: '2027-01-01' } }), [
    { from: '2026-10-01', billing: 'MONTHLY' },
    { from: '2027-01-01', billing: 'ANNUAL' },
  ]);
});

test('predračun: naslov dokumenta, inače iz postavki firme', () => {
  assert.equal(quoteDocTitle({ kind: 'QUOTE', title: 'Proforma' }, { proformaTitle: 'Profaktura' }), 'Ponuda');
  assert.equal(quoteDocTitle({ kind: 'PROFORMA', title: 'Proforma račun' }, { proformaTitle: 'Profaktura' }), 'Proforma račun');
  assert.equal(quoteDocTitle({ kind: 'PROFORMA', title: '  ' }, { proformaTitle: 'Profaktura' }), 'Profaktura');
  assert.equal(quoteDocTitle({ kind: 'PROFORMA', title: null }, { proformaTitle: null }), 'Predračun');
});

test('eRačun: PDV po naplaćenoj naknadi — HR oznaka i napomena', () => {
  const input: UblInput = {
    kind: 'INVOICE',
    number: '1/PP1/1',
    issueDate: '2026-03-05',
    seller: { name: 'Firma d.o.o.', oib: '12345678903', address: 'Ilica 1', zip: '10000', city: 'Zagreb', country: 'HR', iban: 'HR1210010051863000160', vatRegistered: true },
    buyer: { name: 'Kupac d.o.o.', oib: '69435151530', address: 'Riva 2', zip: '21000', city: 'Split', country: 'HR' },
    vatRate: 25,
    taxCategory: 'S',
    lines: [{ description: 'Usluga', unit: 'kom', qty: 1, unitPrice: 100 }],
  };
  const plain = buildUbl(input).xml;
  assert.ok(!plain.includes('HRObracunPDVPoNaplati'));
  assert.ok(!plain.includes('HRFISK20Data'), 'obični račun bez HR proširenja');
  const xml = buildUbl({ ...input, vatOnPayment: true }).xml;
  assert.match(xml, /<hrextac:HRObracunPDVPoNaplati>Obračun po naplaćenoj naknadi<\/hrextac:HRObracunPDVPoNaplati>/);
  assert.ok(xml.includes(`<cbc:Note>${VAT_ON_PAYMENT_NOTE}</cbc:Note>`));
  assert.ok(xml.indexOf('HRObracunPDVPoNaplati') < xml.indexOf('HRTaxTotal'), 'oznaka je prva u HRFISK20Data');
});

test('uvoz stare baze: procesor, ekran i OS po uređaju (zadano s modela), kategorija po komadu i paketi', () => {
  const raw = {
    version: 1,
    categories: [{ id: 'c1', name: 'POS' }, { id: 'c2', name: 'Vage' }],
    models: [{ id: 'm1', brand: 'Sunmi', name: 'T2', categoryId: 'c1', cpu: 'PX30', screen: '15.6"', os: 'Android 11', price: 600 }],
    statuses: [{ id: 's1', name: 'Na skladištu', inStock: true, system: true }],
    warehouses: [{ id: 'w1', name: 'Zagreb' }],
    items: [
      { id: 'i1', serial: 'A1', statusId: 's1', warehouseId: 'w1', modelId: 'm1', cpu: 'RK3566', screen: '—', os: '', categoryId: 'c1' },
      { id: 'i2', serial: 'A2', statusId: 's1', warehouseId: 'w1', modelId: 'm1', categoryId: 'c2' },
      { id: 'i3', serial: 'A3', statusId: 's1', warehouseId: 'w1', modelId: 'm1', categoryId: 'nema' },
    ],
    packages: [{ id: 'pk1', name: 'Starter', price: '1.100,00', note: 'bistro', itemIds: ['i1', 'i2', 'i9'] }],
    settings: { companyName: 'Stara d.o.o.' },
  };
  const r = mapLegacy(raw, { today: '2026-09-25' });
  assert.ok(r);
  const { plan } = r;
  const m = plan.models[0];
  assert.deepEqual([m.cpu, m.screen, m.os], ['PX30', '15.6"', 'Android 11']);
  const [i1, i2, i3] = plan.items;
  // vlastiti procesor; crtica i prazno → s modela
  assert.deepEqual([i1.cpu, i1.screen, i1.os], ['RK3566', '15.6"', 'Android 11']);
  assert.deepEqual([i2.cpu, i2.screen, i2.os], ['PX30', '15.6"', 'Android 11']);
  // kategorija po komadu samo kad odstupa od modela
  assert.equal(i1.categoryKey, null);
  assert.equal(i2.categoryKey, 'c2');
  assert.equal(i3.categoryKey, null);
  assert.ok(plan.warnings.some((w) => w.code === 'ref-category'));
  // paket s postojećim uređajima i cijenom
  assert.equal(plan.packages?.length, 1);
  assert.deepEqual(plan.packages![0], { key: 'pk1', name: 'Starter', price: 1100, note: 'bistro', itemKeys: ['i1', 'i2'], createdAt: null });
  assert.ok(plan.warnings.some((w) => w.code === 'ref-item' && /Starter/.test(w.message)));
});
