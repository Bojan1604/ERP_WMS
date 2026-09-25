/**
 * Područje C — QA krug 2 (najam): plan od budućeg datuma bez rupe (N1), nova mjesečna
 * cijena ne mijenja prošla razdoblja (N2), pauza ne briše povijest (N3), višak
 * fakturiranja nakon kraja ugovora, množina. Iznosi su izračunati ručno (u komentarima).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contractAccrual, contractBilling, historyCharges, overbilledAfter, pendingInstallments,
  type ContractDevice, type ContractTerms,
} from '../src/domain/billing';
import { rebasePlan } from '../src/domain/plan';
import { plural } from '../src/domain/plural';

const terms = (t: Partial<ContractTerms> = {}): ContractTerms => ({
  status: 'ACTIVE', startDate: '2026-01-01', billing: 'MONTHLY', billingMode: 'IN_ADVANCE', billingDay: 1, ...t,
});
const dev = (d: Partial<ContractDevice> = {}): ContractDevice => ({ itemId: 'a', monthly: 30, ...d });
const months = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-${String(from + i).padStart(2, '0')}`);
const sum = (a: number[]) => Math.round(a.reduce((x, v) => x + v, 0) * 100) / 100;

// ---------------------------------------------------------------- N1 plan od budućeg datuma

test('N1: plan od 01.10. (rujan dospio, neizdan) — stari uvjeti do 30.09., rujanska rata ostaje, bez rupe', () => {
  const t = terms();
  const d = dev();
  // siječanj–kolovoz fakturirani, danas 25.09.
  const r = rebasePlan({ terms: t, device: d, next: [{ from: '2026-10-01', billing: 'QUARTERLY' }], covered: new Set(months(1, 8)), now: '2026-09-25' });
  // poruka „vrijedi od" nosi datum koji je korisnik upisao
  assert.equal(r.cut, '2026-10-01');
  assert.deepEqual(r.plan, [{ from: '2026-01-01', to: '2026-09-30' }, { from: '2026-10-01', billing: 'QUARTERLY' }]);
  const after = { ...d, plan: r.plan };
  // 9 × 30 (sij–ruj) + kvartal od listopada 3 × 30 = 90
  assert.deepEqual(contractBilling(t, [after], 2026), [30, 30, 30, 30, 30, 30, 30, 30, 30, 90, 0, 0]);
  // rujanska rata i dalje čeka izdavanje (30 €)
  const pending = pendingInstallments(t, [after], new Set(months(1, 8).map((p) => `a|${p}`)), '2026-09-25');
  assert.deepEqual(pending.map((p) => [p.period, p.amount]), [['2026-09', 30]]);
});

test('N1: plan koji počinje prije granice i dalje vrijedi od prve neizdane rate (tekući mjesec)', () => {
  const r = rebasePlan({ terms: terms(), device: dev(), next: [{ from: '2026-01-01', billing: 'QUARTERLY' }], covered: new Set(months(1, 8)), now: '2026-09-25' });
  assert.equal(r.cut, '2026-09-01');
  assert.deepEqual(r.plan, [{ from: '2026-01-01', to: '2026-08-31' }, { from: '2026-09-01', billing: 'QUARTERLY' }]);
});

// ---------------------------------------------------------------- N2 cijena nije unatrag

test('N2: mjesečna cijena 30 → 60 vrijedi od prve neizdane rate; fakturirani mjeseci ostaju 30', () => {
  const t = terms();
  const d = dev();
  const r = rebasePlan({ terms: t, device: d, next: [], nextMonthly: 60, covered: new Set(months(1, 8)), now: '2026-09-25' });
  assert.equal(r.cut, '2026-09-01');
  assert.deepEqual(r.plan, [{ from: '2026-01-01', to: '2026-08-31', price: 30 }, { from: '2026-09-01' }]);
  const after = { ...d, monthly: 60, plan: r.plan };
  // 8 × 30 = 240, 4 × 60 = 240
  assert.deepEqual(contractBilling(t, [after], 2026), [30, 30, 30, 30, 30, 30, 30, 30, 60, 60, 60, 60]);
  assert.equal(sum(contractAccrual(t, [after], 2026)), 480);
});

test('N2: godišnja rata fakturirana u siječnju — nova cijena tek od sljedeće godine', () => {
  const t = terms({ billing: 'ANNUAL' });
  const r = rebasePlan({ terms: t, device: dev(), next: [], nextMonthly: 60, covered: new Set(['2026-01']), now: '2026-09-25' });
  assert.equal(r.cut, '2027-01-01');
  const after = { ...dev(), monthly: 60, plan: r.plan };
  // 2026: 12 × 30 = 360 (kao na računu); 2027: 12 × 60 = 720
  assert.deepEqual(contractBilling(t, [after], 2026)[0], 360);
  assert.deepEqual(contractBilling(t, [after], 2027)[0], 720);
});

test('N2: uređaj bez prošlih rata — nova cijena vrijedi odmah, plan ostaje prazan', () => {
  const t = terms({ startDate: '2026-10-01' });
  const r = rebasePlan({ terms: t, device: dev(), next: [], nextMonthly: 60, covered: new Set(), now: '2026-09-25' });
  assert.equal(r.cut, null);
  assert.deepEqual(r.plan, []);
});

// ---------------------------------------------------------------- N3 pauza ne briše povijest

test('N3: pauziran ugovor (od 10.09.) — raspored/obračun zadržavaju lipanj–rujan', () => {
  const t = terms({ startDate: '2026-06-01', status: 'PAUSED', pausedSince: '2026-09-10', billing: 'MONTHLY' });
  const d = dev({ monthly: 10 });
  // rujanska rata (01.09.) odlučena prije pauze; listopad nadalje ne
  assert.deepEqual(historyCharges(t, d, '2026-01', '2026-12').map((c) => c.period), months(6, 9));
  assert.equal(sum(contractBilling(t, [d], 2026)), 40);
  assert.equal(sum(contractAccrual(t, [d], 2026)), 40);
  // stara pauza bez datuma: kao i prije — ništa
  assert.equal(sum(contractBilling(terms({ status: 'PAUSED', startDate: '2026-06-01' }), [d], 2026)), 0);
});

test('N3: pauziran uređaj (od 15.08.) — lipanj–kolovoz ostaju, pauzirano razdoblje ne ulazi u zbroj', () => {
  const t = terms({ startDate: '2026-06-01' });
  const d = dev({ monthly: 10, status: 'PAUSED', pausedSince: '2026-08-15', paused: ['2026-07'] });
  assert.deepEqual(historyCharges(t, d, '2026-01', '2026-12').map((c) => c.period), months(6, 8));
  // lipanj + kolovoz (srpanj pauziran) = 20
  assert.equal(sum(contractBilling(t, [d], 2026)), 20);
  assert.equal(sum(contractAccrual(t, [d], 2026)), 20);
});

test('N3: vraćeni uređaj ulazi u obračun do dana skidanja (isti izvor kao raspored)', () => {
  const t = terms({ startDate: '2026-01-01' });
  const current = dev({ itemId: 'a', monthly: 10 });
  const returned = dev({ itemId: 'b', monthly: 20, endDate: '2026-04-15' });
  // tekući 12 × 10 = 120, vraćeni sij–tra 4 × 20 = 80
  assert.equal(sum(contractAccrual(t, [current, returned], 2026)), 200);
  assert.equal(sum(contractBilling(t, [current, returned], 2026)), 200);
});

// ---------------------------------------------------------------- kraj ugovora prije kraja godišnje rate

test('godišnja rata fakturirana, ugovor završava 30.06. — višak srpanj–prosinac za odobrenje', () => {
  const t = terms({ billing: 'ANNUAL' });
  const devices = [dev({ itemId: 'a', monthly: 30 }), dev({ itemId: 'b', monthly: 20 })];
  // a: 6 × 30 = 180, b: 6 × 20 = 120 → 12 mjeseci uređaja, 300 €
  assert.deepEqual(overbilledAfter(t, devices, new Set(['a|2026-01', 'b|2026-01']), '2026-06-30'), { months: 12, amount: 300 });
  // nefakturirana rata nije višak
  assert.deepEqual(overbilledAfter(t, devices, new Set(), '2026-06-30'), { months: 0, amount: 0 });
  // mjesečna naplata do kraja: nema viška
  assert.deepEqual(overbilledAfter(terms(), [dev()], new Set(months(1, 6).map((p) => `a|${p}`)), '2026-06-30'), { months: 0, amount: 0 });
});

test('množina: 1 rata, 3 rate, 5 rata; 1 uređaj, 21 uređaj, 12 uređaja', () => {
  const r = (n: number) => `${n} ${plural(n, 'rata', 'rate', 'rata')}`;
  const u = (n: number) => `${n} ${plural(n, 'uređaj', 'uređaja', 'uređaja')}`;
  assert.deepEqual([1, 3, 5, 22].map(r), ['1 rata', '3 rate', '5 rata', '22 rate']);
  assert.deepEqual([1, 21, 12, 3].map(u), ['1 uređaj', '21 uređaj', '12 uređaja', '3 uređaja']);
});
