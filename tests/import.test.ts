/**
 * Uvoz iz stare verzije — čista pretvorba JSON → plan (bez baze).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mapLegacy } from '../src/server/import/legacy';
import { detectLegacy, INVALID, parseLegacyDate, parseLegacyNumber } from '../src/server/import/legacy-parse';
import { planCounts, type ImportPlan } from '../src/server/import/plan';
import { backupToPlan } from '../src/server/import/backup';
import { sanitizeCompanySettings } from '../src/domain/company';
import { pendingInstallments, type ContractTerms } from '../src/domain/billing';

/** Mala baza u obliku stare verzije (seed.js). */
function legacy() {
  return {
    version: 1,
    users: [
      { id: 'u1', name: 'Ivan Horvat', email: 'admin', pass: 'admin', role: 'admin', active: true },
      { id: 'u5', name: 'Klijent', email: 'hotel', pass: 'hotel', role: 'klijent', active: true },
    ],
    warehouses: [{ id: 'w1', code: 'ZG', name: 'Zagreb — centralno', address: 'Radnička 1' }, { id: 'w2', code: 'ST', name: 'Split' }],
    categories: [{ id: 'c1', name: 'All-in-One POS' }],
    models: [
      { id: 'm1', brand: 'Sunmi', name: 'T2 Lite', price: 620, rentPrice: 45, categoryId: 'c1', cost: 420, cpu: 'PX30', screen: '15.6"', os: '—', minStock: '8', kpd: '26.20.12' },
      { id: 'm2', brand: 'Sunmi', name: 'T2 Lite', price: 1 }, // duplikat → spaja se u m1
    ],
    statuses: [
      { id: 's1', name: 'Na skladištu', color: 'green', inStock: true },
      { id: 's2', name: 'Prodan', color: 'blue', sold: true },
      { id: 's3', name: 'U najmu', color: 'purple', rented: true },
      { id: 's4', name: 'Demo', color: '#ff0000' },
      { id: 's6', name: 'Pokvaren', color: 'red', rma: true },
      { id: 's9', name: 'U dolasku', color: 'teal', returning: true },
      // bez zastavica — prepoznaju se po nazivu (kao ensureStatuses)
      { id: 's10', name: 'Izašlo iz skladišta', color: 'amber' },
    ],
    services: [{ id: 'sv1', name: 'Instalacija', price: '60,00', unit: 'sat' }],
    partners: [
      { id: 'p1', name: 'Caffe Rive d.o.o.', oib: '98765432106', countryCode: 'HR', country: 'HR', isCustomer: true },
      { id: 'p2', name: 'Kaffee Haus GmbH', country: 'EU', vatId: 'AT U12345678' },
      { id: 'p3', name: 'Nepoznata EU', country: 'EU' },
      { id: 'sup1', name: 'Sunmi Europe B.V.', countryCode: 'NL', country: 'EU', isCustomer: false, isSupplier: true },
    ],
    items: [
      { id: 'i1', serial: 'SN1', statusId: 's1', warehouseId: 'w1', partnerId: 'p1', modelId: 'm1', cost: '1.234,56', importDate: '2025-01-10', issueDate: '2025-02-01', invoiceId: 'inv1' },
      { id: 'i2', serial: 'SN2', statusId: 's2', warehouseId: 'w1', partnerId: 'p1', modelId: 'm2', cost: 400, issueDate: '2026-02-01', invoiceId: 'inv1' },
      { id: 'i3', serial: 'SN3', statusId: 's3', warehouseId: 'w2', partnerId: 'p1', modelId: 'm1', cost: 400, rentPrice: 30 },
      { id: 'i4', serial: 'SN4', statusId: 's3', partnerId: 'p2', modelId: 'm1', cost: 400 },
      { id: 'i5', serial: 'SN5', statusId: 's1', warehouseId: 'w1', modelId: 'm1', cost: 400 },
      { id: 'i6', serial: 'SN5', dupNote: '', statusId: 'nepostojeci', modelId: 'nema', cost: 'x', importDate: '31.02.2025.' },
      { id: 'i7', serial: 'SN7', statusId: 's10', modelId: 'm1', outAt: '2026-09-01T10:00:00Z', outNote: 'kod kupca', partnerId: 'p1' },
      { id: 'i8', serial: 'SN8', statusId: 's4', partnerId: 'p1', modelId: 'm1' },
    ],
    invoices: [
      { id: 'inv1', number: '1/ZG/1', partnerId: 'p1', type: 'prodaja', date: '2026-02-01', vatRate: 25, lines: [{ itemId: 'i2', desc: 'T2 Lite', serial: 'SN2', qty: 1, price: '1.000,00' }], paidDate: '2026-02-10' },
      { id: 'inv2', number: '2/ZG/1', partnerId: 'p1', type: 'prodaja', kind: 'predujam', date: '2026-02-05', vatRate: 25, lines: [{ desc: 'Predujam', qty: 1, price: 400, kind: 'rucno' }], payments: [{ date: '2026-02-06', amount: '100,00' }] },
      { id: 'inv3', number: '3/ZG/1', partnerId: 'p1', type: 'prodaja', date: '2026-02-07', vatRate: 25, lines: [{ serviceId: 'sv1', desc: 'Instalacija', qty: 2, price: 60, discount: 10, kind: 'usluga' }], stornoId: 'inv4', paidDate: '' },
      { id: 'inv4', number: '4/ZG/1', kind: 'storno', refInvoiceId: 'inv3', partnerId: 'p1', type: 'prodaja', date: '2026-02-08', vatRate: 25, lines: [{ serviceId: 'sv1', desc: 'Instalacija', qty: 2, price: -60, discount: 10, kind: 'usluga' }], paidDate: '2026-02-08' },
      { id: 'inv5', number: '5/ZG/1', kind: 'odobrenje', refInvoiceId: 'inv1', partnerId: 'p1', type: 'prodaja', date: '2026-02-09', vatRate: 25, lines: [{ desc: 'Popust', qty: 1, price: -100, kind: 'rucno' }], paidDate: '2026-02-09' },
      { id: 'inv6', number: '6/ZG/1', partnerId: 'p1', type: 'najam', contractId: 'k1', period: '2026-01', date: '2026-01-02', vatRate: 25, lines: [{ itemId: 'i3', desc: 'Najam', qty: 1, monthly: 30, price: 30, kind: 'uredaj' }] },
      { id: 'inv7', number: '6/ZG/1', partnerId: 'p1', type: 'prodaja', date: '2026-03-01', vatRate: 25, lines: [{ desc: 'Duplikat broja', qty: 1, price: 1 }] },
      { id: 'inv8', number: '', partnerId: 'nema', type: 'prodaja', date: '2026-03-02', lines: [{ desc: 'Nacrt', qty: 1, price: 10 }] },
    ],
    contracts: [
      {
        id: 'k1', number: 'UG-2026-001', partnerId: 'p1', itemIds: ['i3', 'i4', 'i5'], prices: { i3: '30,00', i4: 20 },
        terms: {
          i3: { plan: [{ from: '2026-01-01', to: '2026-03-31', billing: 'jednokratno' }, { from: '2026-04-01', billing: 'kvartalno', price: '31,50', seasonal: null }] },
          i4: { billing: 'godisnje', seasonal: { from: 5, to: 9 }, status: 'pauziran' },
        },
        startDate: '2026-01-01', endDate: '', billing: 'mjesecno', billingMode: 'unaprijed', firstBillingDate: '', seasonal: { from: 4, to: 10 },
        status: 'aktivan', skipped: ['i3|2026-02', 'i9|2026-01', 'pogresno'],
      },
    ],
    rent: { i3: { 2026: [null, 12.5, null, null, null, null, null, null, null, null, null, '7,25'] }, nema: { 2026: [1] } },
    priceLists: [{ id: 'pl1', partnerId: 'p1', modelId: 'm1', salePrice: 0, rentPrice: 45 }],
    quotes: [{ id: 'q1', number: 'P-2026-001', partnerId: 'p1', date: '2026-03-01', status: 'istekla', lines: [{ kind: 'model', modelId: 'm1', desc: 'T2', qty: 2, price: 600 }], discountPct: 5 }],
    orders: [{ id: 'o1', number: 'NAR-1', supplierId: 'sup1', date: '2026-01-05', status: 'djelomicno', lines: [{ modelId: 'm1', qty: 5, cost: 400, received: 2 }] }],
    receipts: [{ id: 'r1', number: 'PRM-2026-0001', date: '2026-01-10', orderId: 'o1', supplierId: 'sup1', warehouseId: 'w1', itemIds: ['i5'], expenseId: 'e2', lines: [{ modelId: 'm1', qty: 1, cost: 400 }] }],
    transfers: [{ id: 't1', number: 'PR-2026-0001', date: '2026-01-11', fromWarehouseId: 'w1', toWarehouseId: 'w2', itemIds: ['i5'] }, { id: 't2', number: 'PR-2', itemIds: [] }],
    rma: [{ id: 'rm1', number: 'RMA-2026-0003', itemId: 'i8', serial: 'SN8', status: 'Kod dobavljača', reportedDate: '2026-03-01', issue: 'Ne pali' }],
    inbound: [{ id: 'in1', number: 'R-1', supplierName: 'Novi dobavljač', supplierOib: '11111111111', issueDate: '2026-03-01', total: '125,00', vatRate: 25 }],
    expenses: [
      { id: 'e1', date: '2026-01-05', category: 'Pretplate', description: 'Mobiteli', amount: '128,40', vatRate: 25, paid: true, recurring: { freq: 'mjesecno', until: '' }, overrides: { '2026-02': { amount: '140,20' }, '2026-03': { skipped: true }, x: 1 } },
      { id: 'e2', date: '2026-01-10', category: 'Nabava robe', description: 'Primka', amount: 400, vatRate: 0 },
    ],
    audit: [{ id: 'l1', ts: '2026-01-01T10:00:00Z', userName: 'Sustav', entity: 'Sustav', action: 'seed', summary: 'Demo' }],
    settings: { companyName: 'Stara firma d.o.o.', companyOib: '12345678903', companyAddress: 'Radnička 1, 10000 Zagreb', vatRate: 25, invoicePrefix: 'ZG-1', invoiceCounters: { 2026: 9 } },
  };
}

const plan = (raw: unknown = legacy()): ImportPlan => {
  const r = mapLegacy(raw, { today: '2026-03-15' });
  assert.ok(r, 'oblik mora biti prepoznat');
  return r.plan;
};
const codes = (p: ImportPlan) => new Set(p.warnings.map((w) => w.code));

test('brojevi: hrvatski i strojni zapis', () => {
  assert.equal(parseLegacyNumber('1.234,56'), 1234.56);
  assert.equal(parseLegacyNumber('1234.56'), 1234.56);
  assert.equal(parseLegacyNumber('12,5'), 12.5);
  assert.equal(parseLegacyNumber('1 500 €'), 1500);
  assert.equal(parseLegacyNumber('1.500.000'), 1500000);
  assert.equal(parseLegacyNumber('1,234,567'), 1234567);
  assert.equal(parseLegacyNumber('-45,00'), -45);
  assert.equal(parseLegacyNumber(42), 42);
  assert.equal(parseLegacyNumber(''), null);
  assert.equal(parseLegacyNumber(null), null);
  assert.ok(Number.isNaN(parseLegacyNumber('abc')));
  assert.ok(Number.isNaN(parseLegacyNumber(true)));
});

test('datumi: ISO, hrvatski zapis, neispravni i vrijeme u UTC-u', () => {
  assert.equal(parseLegacyDate('2026-03-05'), '2026-03-05');
  assert.equal(parseLegacyDate('5.3.2026.'), '2026-03-05');
  assert.equal(parseLegacyDate('05.03.2026'), '2026-03-05');
  assert.equal(parseLegacyDate('31.02.2025.'), INVALID);
  assert.equal(parseLegacyDate('2026-13-01'), INVALID);
  assert.equal(parseLegacyDate('sutra'), INVALID);
  assert.equal(parseLegacyDate(''), null);
  // 22:30 UTC 31. 3. je već 1. 4. u Zagrebu
  assert.equal(parseLegacyDate('2026-03-31T22:30:00.000Z'), '2026-04-01');
});

test('prepoznavanje oblika: baza, omotači, dnevna kopija, zapisi po kolekciji', () => {
  const d = legacy();
  assert.equal(detectLegacy(d)?.format, 'legacy-db');
  assert.equal(detectLegacy({ data: d })?.format, 'legacy-wrapped');
  assert.equal(detectLegacy({ db: d })?.format, 'legacy-wrapped');
  const b = detectLegacy({ date: '2026-03-01', savedAt: '2026-03-01T08:00:00Z', data: d });
  assert.equal(b?.format, 'legacy-backup');
  assert.equal(b?.exportedAt, '2026-03-01T08:00:00Z');
  const split = Object.fromEntries(Object.entries(d).map(([k, v]) => [`db:fir_1:${k}`, v]));
  const s = detectLegacy({ ...split, companies: { list: [{ id: 'fir_1', name: 'Firma Jedan' }], active: 'fir_1' } });
  assert.equal(s?.format, 'legacy-split');
  assert.equal((s?.db.items as unknown[]).length, d.items.length);
  const kv = detectLegacy(Object.entries(split).map(([key, value]) => ({ key, value })));
  assert.equal(kv?.format, 'legacy-split');
  const keyed = detectLegacy({ 'backup:fir_1:2026-03-01': { data: { items: [] } }, 'backup:fir_1:2026-03-02': { savedAt: 'x', data: d } });
  assert.equal(keyed?.format, 'legacy-backup');
  assert.equal((keyed?.db.items as unknown[]).length, d.items.length);
  assert.equal(detectLegacy({ foo: 1 }), null);
  assert.equal(detectLegacy([1, 2]), null);
});

test('statusi: zastavice → vrste, prepoznavanje po nazivu, sistemski statusi', () => {
  const p = plan();
  const kind = (name: string) => p.statuses.find((s) => s.name === name)?.kind;
  assert.equal(kind('Na skladištu'), 'IN_STOCK');
  assert.equal(kind('Prodan'), 'SOLD');
  assert.equal(kind('U najmu'), 'RENTED');
  assert.equal(kind('Pokvaren'), 'SERVICE');
  assert.equal(kind('U dolasku'), 'RETURNING');
  assert.equal(kind('Izašlo iz skladišta'), 'RESERVED'); // po nazivu
  assert.equal(kind('Demo'), 'OTHER');
  assert.equal(p.statuses.find((s) => s.name === 'Demo')?.color, 'gray'); // #ff0000 → siva
  // otpisa nema u datoteci — dodan sistemski
  const wo = p.statuses.find((s) => s.kind === 'WRITTEN_OFF');
  assert.ok(wo?.system);
  for (const k of ['IN_STOCK', 'RESERVED', 'SOLD', 'RENTED', 'SERVICE', 'RETURNING', 'WRITTEN_OFF']) {
    assert.equal(p.statuses.filter((s) => s.kind === k && s.system).length, 1, `sistemski ${k}`);
  }
});

test('uređaji: stanje po statusu, pravila čistoće, dupli serijski, nepoznate veze', () => {
  const p = plan();
  const it = (serial: string, note?: string) => p.items.find((i) => i.serial === serial && (note === undefined || i.dupNote === note))!;
  // na skladištu: nema kupca, računa ni datuma izdavanja
  assert.equal(it('SN1').state, 'IN_STOCK');
  assert.equal(it('SN1').partnerKey, null);
  assert.equal(it('SN1').invoiceKey, null);
  assert.equal(it('SN1').issueDate, null);
  assert.equal(it('SN1').cost, 1234.56);
  // prodan: bez skladišta, vezan uz račun, prodajna cijena = udio s računa
  assert.equal(it('SN2').state, 'SOLD');
  assert.equal(it('SN2').warehouseKey, null);
  assert.equal(it('SN2').invoiceKey, 'inv1');
  assert.equal(it('SN2').salePrice, 1000);
  assert.equal(it('SN2').modelKey, 'm1'); // m2 spojen u m1
  // izašao iz skladišta zadržava trag izlaza, ostali ga nemaju
  assert.equal(it('SN7').state, 'RESERVED');
  assert.ok(it('SN7').outAt);
  assert.equal(it('SN8').outAt, null);
  // dupli serijski bez napomene → razlikovna napomena
  const dup = p.items.filter((i) => i.serial === 'SN5');
  assert.equal(dup.length, 2);
  assert.deepEqual(dup.map((i) => i.dupNote), [null, 'uvoz 2']);
  const w = codes(p);
  for (const c of ['dup-serial', 'ref-status', 'ref-model', 'number', 'date']) assert.ok(w.has(c), `upozorenje ${c}`);
  assert.equal(p.models.length, 2); // T2 Lite + „Nepoznat model (uvoz)"
  assert.equal(p.models[0].specs, 'PX30 · 15.6"');
  assert.equal(p.models[0].minStock, 8);
});

test('partneri: država EU → ISO s upozorenjem', () => {
  const p = plan();
  const c = (name: string) => p.partners.find((x) => x.name === name)?.country;
  assert.equal(c('Caffe Rive d.o.o.'), 'HR');
  assert.equal(c('Kaffee Haus GmbH'), 'AT'); // iz PDV broja
  assert.equal(c('Nepoznata EU'), 'DE');
  assert.equal(c('Sunmi Europe B.V.'), 'NL');
  assert.ok(p.warnings.some((w) => w.code === 'partner-country' && w.message.includes('Nepoznata EU')));
  assert.ok(p.partners.find((x) => x.name === 'Sunmi Europe B.V.')?.isSupplier);
});

test('računi: vrste, storno, odobrenje, uplate i preračunati zbrojevi', () => {
  const p = plan();
  const inv = (k: string) => p.invoices.find((i) => i.key === k)!;
  assert.equal(inv('inv1').kind, 'INVOICE');
  assert.equal(inv('inv2').kind, 'ADVANCE');
  assert.equal(inv('inv4').kind, 'STORNO');
  assert.equal(inv('inv5').kind, 'CREDIT_NOTE');
  assert.equal(inv('inv6').type, 'RENT');
  // račun: 1000 + 25 % = 1250; odobrenje 100 + PDV = 125; stari paidDate = plaćeno u cijelosti (ostatak)
  const t1 = inv('inv1').totals!;
  assert.equal(t1.grandTotal, 1250);
  assert.equal(t1.creditedTotal, 125);
  assert.equal(inv('inv1').payments.length, 1);
  assert.equal(t1.paidTotal, 1125);
  assert.equal(t1.openAmount, 0);
  assert.equal(t1.paidDate, '2026-02-10');
  assert.equal(t1.costTotal, 400);
  // predujam s djelomičnom uplatom
  assert.equal(inv('inv2').totals!.openAmount, 400);
  // storno: nova konvencija (negativna količina), izvorni storniran, bez potraživanja
  assert.equal(inv('inv4').lines[0].qty, -2);
  assert.equal(inv('inv4').lines[0].unitPrice, 60);
  assert.equal(inv('inv4').totals!.grandTotal, -135);
  assert.equal(inv('inv4').refInvoiceKey, 'inv3');
  assert.ok(inv('inv3').stornoed);
  assert.equal(inv('inv3').totals!.openAmount, 0);
  assert.equal(inv('inv4').payments.length, 0); // storno nema uplata
  assert.equal(inv('inv5').lines[0].qty, -1);
  // broj i redni broj
  assert.equal(inv('inv1').seq, 1);
  assert.equal(inv('inv1').paymentRef, '1-2026');
  assert.equal(inv('inv6').seq, 6);
  assert.equal(inv('inv7').seq, null); // duplikat rednog broja
  assert.equal(inv('inv7').number, '6/ZG/1');
  assert.equal(inv('inv8').status, 'DRAFT');
  assert.equal(inv('inv8').partnerKey, p.partners.find((x) => x.name === 'Nepoznat kupac (uvoz)')?.key);
  // najam: mjesečna cijena × mjeseci
  assert.equal(inv('inv6').lines[0].monthly, 30);
  assert.equal(inv('inv6').lines[0].months, 1);
  assert.equal(inv('inv6').contractKey, 'k1');
  assert.equal(inv('inv6').period, '2026-01');
  // usluga s popustom
  assert.equal(inv('inv3').lines[0].kind, 'SERVICE');
  assert.equal(inv('inv3').totals!.netTotal, 108);
  // brojač: max(uvezeni redni broj, stari brojač)
  assert.equal(p.counters.find((c) => c.series === 'INVOICE' && c.year === 2026)?.last, 9);
  assert.ok(codes(p).has('invoice-dup-seq'));
});

test('ugovori: plan naplate, sezona, status uređaja, preskočena razdoblja', () => {
  const p = plan();
  const k = p.contracts[0];
  assert.equal(k.number, 'UG-2026-001');
  assert.equal(k.billing, 'MONTHLY');
  assert.equal(k.billingMode, 'IN_ADVANCE');
  assert.deepEqual([k.seasonFrom, k.seasonTo], [4, 10]);
  // i5 je na skladištu → ne ostaje na ugovoru (pravilo nove verzije)
  assert.deepEqual(k.items.map((i) => i.itemKey), ['i3', 'i4']);
  assert.ok(codes(p).has('contract-item-state'));
  const i3 = k.items[0];
  assert.equal(i3.monthly, 30);
  // prvo razdoblje nasljeđuje sezonu ugovora, drugo izričito „cijela godina" (seasonal: null → 0/0)
  assert.deepEqual(i3.plan, [
    { from: '2026-01-01', to: '2026-03-31', billing: 'ONCE' },
    { from: '2026-04-01', billing: 'QUARTERLY', price: 31.5, seasonFrom: 0, seasonTo: 0 },
  ]);
  assert.deepEqual(i3.skipped, ['2026-02']);
  const i4 = k.items[1];
  assert.equal(i4.status, 'PAUSED');
  assert.deepEqual(i4.plan, [{ from: '2026-01-01', billing: 'ANNUAL', seasonFrom: 5, seasonTo: 9 }]);
  // najmoprimac postaje kupac uređaja
  assert.equal(p.items.find((i) => i.key === 'i4')!.partnerKey, 'p1');
  assert.ok(codes(p).has('skipped'));

  // motor naplate nad uvezenim planom: jednokratna rata za siječanj otpada jer je siječanj izvan sezone
  // ugovora (tra–lis) — kao u staroj verziji; od travnja kvartalno 3 × 31,50 cijelu godinu; i4 je pauziran
  const terms: ContractTerms = { status: 'ACTIVE', startDate: k.startDate, endDate: k.endDate, firstBillingDate: k.firstBillingDate, billingDay: k.billingDay, billing: k.billing, billingMode: k.billingMode, seasonFrom: k.seasonFrom, seasonTo: k.seasonTo };
  const pend = pendingInstallments(terms, k.items.map((ci) => ({ itemId: ci.itemKey, monthly: ci.monthly, plan: ci.plan, status: ci.status, skipped: ci.skipped })), new Set(), '2026-04-15');
  assert.deepEqual(pend.map((r) => [r.period, r.amount]), [['2026-04', 94.5]]);
  // bez sezone ugovora jednokratna rata pokriva tri mjeseca (3 × 30)
  const noSeason = pendingInstallments({ ...terms, seasonFrom: null, seasonTo: null }, [{ itemId: 'i3', monthly: 30, plan: i3.plan }], new Set(), '2026-02-15');
  assert.deepEqual(noSeason.map((r) => [r.period, r.amount]), [['2026-01', 90]]);
});

test('najam po mjesecima, ponude, nabava, servis, ulazni, troškovi', () => {
  const p = plan();
  assert.deepEqual(p.rentOverrides.map((r) => [r.itemKey, r.year, r.month, r.amount]), [['i3', 2026, 2, 12.5], ['i3', 2026, 12, 7.25]]);
  assert.equal(p.quotes[0].status, 'SENT');
  assert.equal(p.quotes[0].lines[0].kind, 'MODEL');
  assert.equal(p.orders[0].status, 'PARTIAL');
  assert.equal(p.receipts[0].total, 400);
  assert.equal(p.items.find((i) => i.key === 'i5')!.receiptKey, 'r1');
  assert.equal(p.transfers.length, 1); // bez odredišta se preskače
  assert.equal(p.serviceOrders[0].status, 'AT_SUPPLIER');
  const si = p.supplierInvoices[0];
  assert.deepEqual([si.netAmount, si.vatAmount, si.total], [100, 25, 125]);
  assert.match(si.internalNo, /^URA-2026-0001$/);
  assert.ok(p.partners.some((x) => x.name === 'Novi dobavljač' && x.oib === '11111111111' && x.isSupplier));
  const e1 = p.expenses.find((e) => e.key === 'e1')!;
  assert.equal(e1.frequency, 'MONTHLY');
  assert.equal(e1.netAmount, 128.4);
  assert.equal(e1.vatAmount, 32.1);
  assert.deepEqual(e1.overrides, { '2026-02': { amount: 140.2 }, '2026-03': { skipped: true } });
  const e2 = p.expenses.find((e) => e.key === 'e2')!;
  assert.equal(e2.source, 'RECEIPT');
  assert.equal(e2.receiptKey, 'r1');
  assert.equal(p.priceAgreements[0].salePrice, null);
  assert.equal(p.priceAgreements[0].rentPrice, 45);
  // korisnici se samo popisuju (klijent RMA portala se preskače)
  assert.deepEqual(p.users.map((u) => [u.name, u.role]), [['Ivan Horvat', 'ADMIN']]);
  assert.equal(p.company.invoicePremises, 'ZG');
  assert.equal(p.company.invoiceDevice, '1');
  assert.equal(p.company.city, 'Zagreb');
});

test('pogrešni zapisi se preskaču uz upozorenje, a ne ruše uvoz', () => {
  const d = legacy() as Record<string, unknown>;
  d.items = [...(d.items as unknown[]), 'nije objekt', null];
  d.invoices = { nije: 'popis' };
  const p = plan(d);
  assert.equal(p.items.length, 8);
  assert.equal(p.invoices.length, 0);
  assert.ok(codes(p).has('record'));
  assert.ok(codes(p).has('collection'));
});

test('ogledna datoteka iz stare verzije (scripts/fixtures/legacy-sample.json)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fixtures', 'legacy-sample.json'), 'utf8'));
  const p = plan(raw);
  const n = planCounts(p);
  assert.equal(n.items, raw.items.length);
  assert.equal(n.invoices, raw.invoices.length);
  assert.equal(n.contracts, raw.contracts.length);
  assert.ok(!p.warnings.some((w) => w.level === 'error'));
  // svaki uređaj na ugovoru je u najmu ili u dolasku, svaki na skladištu je „čist"
  const rented = new Set(p.contracts.flatMap((k) => k.items.map((i) => i.itemKey)));
  for (const it of p.items) {
    if (rented.has(it.key)) assert.ok(it.state === 'RENTED' || it.state === 'RETURNING');
    if (it.state === 'IN_STOCK') assert.equal(it.partnerKey, null);
  }
});

// ---------------------------------------------------------------- sigurnosna kopija: prilozi i postavke firme

test('kopija: prilozi se provjeravaju po sadržaju, nepoznata vrsta zapisa i HTML se odbacuju', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');
  const html = Buffer.from('<html><script>alert(document.cookie)</script></html>').toString('base64');
  const plan = backupToPlan({
    format: 'erp-wms-backup',
    version: 1,
    company: { name: 'Kopija d.o.o.' },
    attachments: [
      { id: 'a1', entity: 'item', entityId: 'i1', fileName: '../../naljepnica.html', mime: 'text/html', size: 999999, data: png },
      { id: 'a2', entity: 'item', entityId: 'i1', fileName: 'x.png', mime: 'image/png', size: 10, data: html },
      { id: 'a3', entity: 'nepoznato', entityId: 'inv1', fileName: 'y.png', mime: 'image/png', size: 12, data: png },
      { id: 'a4', entity: 'item', entityId: 'i1', fileName: 'z.png', mime: 'image/png', size: 0, data: 'A'.repeat(14 * 1024 * 1024) },
      { id: 'a5', entity: 'item', entityId: 'i1', fileName: 'bez.png' },
    ],
  });
  assert.equal(plan.attachments.length, 1);
  const [a] = plan.attachments;
  assert.equal(a.mime, 'image/png'); // iz sadržaja, ne iz datoteke
  assert.equal(a.size, 12); // stvarna veličina
  assert.equal(a.fileName, 'naljepnica.png'); // bez putanje, nastavak prema vrsti
  assert.equal(plan.warningCounts['attachment-invalid'], 4);
  assert.ok(plan.warnings.some((w) => /nepoznata vrsta zapisa „nepoznato"/.test(w.message)));
  assert.ok(plan.warnings.some((w) => /nije slika/.test(w.message)));
});

test('postavke firme iz datoteke: valuta, logo, granice brojeva, oznake računa', () => {
  const { company, notes } = sanitizeCompanySettings({
    name: 'Firma', currency: 'EUR"><script>', country: 'hr', logo: 'javascript:alert(1)', vatRate: 250, overdueDays: -5, paymentTermDays: '30',
    defaultWarrantyMonths: 12.6, rentFallbackPct: 'x', invoicePremises: 'PP 1', invoiceDevice: '1', invoiceSeparator: '/', vatRegistered: 'da',
  });
  assert.equal(company.currency, 'EUR');
  assert.equal(company.country, 'HR');
  assert.equal(company.logo, undefined);
  assert.equal(company.vatRate, 100);
  assert.equal(company.overdueDays, 0);
  assert.equal(company.paymentTermDays, 30);
  assert.equal(company.defaultWarrantyMonths, 13);
  assert.equal(company.rentFallbackPct, undefined);
  assert.equal(company.invoicePremises, undefined);
  assert.equal(company.invoiceDevice, '1');
  assert.equal(company.invoiceSeparator, '/');
  assert.equal(company.vatRegistered, undefined);
  assert.ok(notes.some((n) => /valuta/.test(n)));
  assert.ok(notes.some((n) => /Logo/.test(n)));
  assert.equal(sanitizeCompanySettings({ currency: 'usd' }).company.currency, 'USD');
  const logo = `data:image/png;base64,${'A'.repeat(1000)}`;
  assert.equal(sanitizeCompanySettings({ logo }).company.logo, logo);
  assert.equal(sanitizeCompanySettings({ logo: `data:image/png;base64,${'A'.repeat(500_000)}` }).company.logo, undefined);
  assert.equal(sanitizeCompanySettings({ logo: 'data:text/html;base64,PHNjcmlwdD4=' }).company.logo, undefined);

  const plan = backupToPlan({ format: 'erp-wms-backup', version: 1, company: { name: 'K', currency: '<x>', logo: 'data:text/html,<script>' } });
  assert.equal(plan.company.currency, 'EUR');
  assert.equal(plan.company.logo, undefined);
  assert.equal(plan.warningCounts['company-settings'], 2);
});
