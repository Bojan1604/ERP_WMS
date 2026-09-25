/** Područje C (QA t2): sezona unutar razdoblja, razmjerna rata do kraja, pauza, izmjena uvjeta od prve neizdane rate. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contractAccrual, contractBilling, deviceCharges, nextBillingDate, pendingInstallments, scheduledCharges,
  type BillingCode, type ContractDevice, type ContractTerms,
} from '../src/domain/billing';
import { applyBulkTerms, bulkCutoff, rebasePlan, validatePlan } from '../src/domain/plan';

const terms = (t: Partial<ContractTerms> = {}): ContractTerms => ({
  status: 'ACTIVE', startDate: '2026-01-01', billing: 'MONTHLY', billingMode: 'IN_ADVANCE', billingDay: 1, ...t,
});
const dev = (d: Partial<ContractDevice> = {}): ContractDevice => ({ itemId: 'a', monthly: 10, ...d });
const sum = (a: number[]) => Math.round(a.reduce((x, v) => x + v, 0) * 100) / 100;
const charges = (t: ContractTerms, d: ContractDevice, from = '2026-01', to = '2026-12') =>
  deviceCharges(t, d, from, to).map((c) => [c.period, c.amount, c.months]);
const cover = (itemId: string, periods: string[]) => new Set(periods.map((p) => `${itemId}|${p}`));

// ---------------------------------------------------------------- #4 sezona unutar razdoblja rate

test('kvartalno + sezona tra–lis: naplaćuju se samo sezonski mjeseci razdoblja', () => {
  const t = terms({ billing: 'QUARTERLY', seasonFrom: 4, seasonTo: 10 });
  // siječanj (bez sezone) nema ratu, travanj i srpanj po 3 mjeseca, listopad samo 1
  assert.deepEqual(charges(t, dev()), [['2026-04', 30, 3], ['2026-07', 30, 3], ['2026-10', 10, 1]]);
  assert.equal(sum(contractBilling(t, [dev()], 2026)), 70);
  assert.equal(sum(contractAccrual(t, [dev()], 2026)), 70);
});

test('kvartalno od veljače + sezona tra–lis: travanj naplaćuje veljačka rata (ne gubi se)', () => {
  const t = terms({ billing: 'QUARTERLY', startDate: '2026-02-01', seasonFrom: 4, seasonTo: 10 });
  assert.deepEqual(charges(t, dev()), [['2026-02', 10, 1], ['2026-05', 30, 3], ['2026-08', 30, 3]]);
  const feb = scheduledCharges(t, dev(), '2026-02', '2026-02')[0];
  assert.deepEqual(feb.covers, ['2026-04']);
  assert.equal(sum(contractBilling(t, [dev()], 2026)), sum(contractAccrual(t, [dev()], 2026)));
});

test('polugodišnje i godišnje + sezona', () => {
  const semi = terms({ billing: 'SEMIANNUAL', seasonFrom: 4, seasonTo: 10 });
  assert.deepEqual(charges(semi, dev()), [['2026-01', 30, 3], ['2026-07', 40, 4]]);
  const annual = terms({ billing: 'ANNUAL', seasonFrom: 4, seasonTo: 10 });
  assert.deepEqual(charges(annual, dev()), [['2026-01', 70, 7]]);
  // sezona preko prijeloma godine (stu–velj), kvartalno: siječanj (sij, velj) i listopad (stu, pro)
  const winter = terms({ billing: 'QUARTERLY', seasonFrom: 11, seasonTo: 2 });
  assert.deepEqual(charges(winter, dev()), [['2026-01', 20, 2], ['2026-10', 20, 2]]);
  assert.deepEqual(contractAccrual(winter, [dev()], 2026), [10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 10, 10]);
});

test('sezona na razdoblju plana uređaja (kvartalno ljeti, lip–ruj)', () => {
  const t = terms();
  const d = dev({ plan: [{ from: '2026-01-01', billing: 'QUARTERLY', seasonFrom: 6, seasonTo: 9 }] });
  assert.deepEqual(charges(t, d), [['2026-04', 10, 1], ['2026-07', 30, 3]]);
});

// ---------------------------------------------------------------- #5 razmjerno do kraja

test('unatrag: kvartal otkazan 25.09. naplaćuje samo rujan', () => {
  const t = terms({ billing: 'QUARTERLY', billingMode: 'IN_ARREARS', startDate: '2026-03-01', status: 'TERMINATED', endDate: '2026-09-25', closedAt: '2026-09-25' });
  const pend = pendingInstallments(t, [dev()], cover('a', ['2026-03', '2026-06']), '2026-10-02');
  assert.deepEqual(pend.map((p) => [p.period, p.amount, p.lines[0].months]), [['2026-09', 10, 1]]);
});

test('unaprijed: kraj ugovora usred kvartala smanjuje neizdanu ratu', () => {
  const t = terms({ billing: 'QUARTERLY', endDate: '2026-11-30' });
  assert.deepEqual(charges(t, dev()), [['2026-01', 30, 3], ['2026-04', 30, 3], ['2026-07', 30, 3], ['2026-10', 20, 2]]);
  assert.equal(sum(contractBilling(t, [dev()], 2026)), sum(contractAccrual(t, [dev()], 2026)));
});

test('skinut uređaj: rata razdoblja skidanja do mjeseca skidanja', () => {
  const t = terms({ billing: 'QUARTERLY' });
  const returned = dev({ endDate: '2026-05-10' });
  assert.deepEqual(charges(t, returned), [['2026-01', 30, 3], ['2026-04', 20, 2]]);
  const semi = dev({ endDate: '2026-02-15', plan: [{ from: '2026-01-01', billing: 'SEMIANNUAL' }] });
  assert.deepEqual(charges(t, semi), [['2026-01', 20, 2]]);
  // unatrag: zaostala rata skinutog uređaja razmjerna
  const arr = terms({ billing: 'QUARTERLY', billingMode: 'IN_ARREARS' });
  const pend = pendingInstallments(arr, [returned], cover('a', ['2026-01']), '2026-06-01');
  assert.deepEqual(pend.map((p) => [p.period, p.amount]), [['2026-04', 20]]);
});

test('jednokratno: mjeseci do kraja ugovora; bez kraja jedan mjesec (i u obračunu)', () => {
  const withEnd = terms({ billing: 'ONCE', startDate: '2026-09-01', endDate: '2026-12-31' });
  assert.deepEqual(charges(withEnd, dev()), [['2026-09', 40, 4]]);
  assert.equal(sum(contractAccrual(withEnd, [dev()], 2026)), 40);
  const open = terms({ billing: 'ONCE', startDate: '2026-09-01' });
  assert.deepEqual(charges(open, dev()), [['2026-09', 10, 1]]);
  assert.deepEqual(contractAccrual(open, [dev()], 2026), [0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0]);
});

// ---------------------------------------------------------------- dosljednost Naplata == Obračun

test('Naplata za godinu == Obračun za iste mjesece (ugovor cijelu godinu, sve učestalosti, sezone i kraj)', () => {
  const billings: BillingCode[] = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'];
  const seasons: Array<[number | null, number | null]> = [[null, null], [4, 10], [11, 2], [6, 6], [1, 12]];
  const ends = [null, '2026-08-15', '2026-12-31'];
  for (const billing of billings)
    for (const [seasonFrom, seasonTo] of seasons)
      for (const endDate of ends)
        for (const billingMode of ['IN_ADVANCE', 'IN_ARREARS'] as const) {
          const t = terms({ billing, seasonFrom, seasonTo, endDate, billingMode });
          const devices = [dev(), dev({ itemId: 'b', monthly: 7.35, endDate: '2026-10-20' })];
          const label = `${billing} ${seasonFrom}-${seasonTo} kraj ${endDate} ${billingMode}`;
          assert.equal(sum(contractBilling(t, devices, 2026)), sum(contractAccrual(t, devices, 2026)), label);
        }
});

test('pauzirana rata: ne ulazi ni u naplatu ni u obračun (kvartal sa sezonom)', () => {
  const t = terms({ billing: 'QUARTERLY', startDate: '2026-02-01', seasonFrom: 4, seasonTo: 10 });
  const d = dev({ paused: ['2026-02'] });
  // veljačka rata pokriva samo travanj — pauza gasi travanj u obračunu, ne veljaču
  const acc = contractAccrual(t, [d], 2026);
  assert.equal(acc[3], 0);
  assert.equal(sum(acc), 60);
  assert.equal(sum(contractBilling(t, [d], 2026)), 60);
});

// ---------------------------------------------------------------- #10 pauza: rate prije pauze ostaju

test('pauziran ugovor: neizdane rate od prije pauze ostaju za izdati', () => {
  const t = terms({ status: 'PAUSED', pausedSince: '2026-05-10' });
  const pend = pendingInstallments(t, [dev()], cover('a', ['2026-01', '2026-02', '2026-03']), '2026-09-25');
  assert.deepEqual(pend.map((p) => p.period), ['2026-04', '2026-05']);
  // stara pauza bez početka — ništa
  assert.deepEqual(pendingInstallments(terms({ status: 'PAUSED' }), [dev()], new Set(), '2026-09-25'), []);
  // unatrag: odlučuje početak razdoblja (svibanj pružen prije pauze, izdaje se u lipnju)
  const arr = terms({ status: 'PAUSED', pausedSince: '2026-05-10', billingMode: 'IN_ARREARS' });
  assert.deepEqual(pendingInstallments(arr, [dev()], cover('a', ['2026-01', '2026-02', '2026-03']), '2026-09-25').map((p) => p.period), ['2026-04', '2026-05']);
});

test('pauziran uređaj: rate prije pauze ostaju, nakon pauze ne; drugi uređaj normalno', () => {
  const t = terms();
  const paused = dev({ status: 'PAUSED', pausedSince: '2026-08-15' });
  const other = dev({ itemId: 'b' });
  const covered = new Set([...cover('a', ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']), ...cover('b', ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'])]);
  const pend = pendingInstallments(t, [paused, other], covered, '2026-09-25');
  assert.deepEqual(pend.map((p) => [p.period, p.lines.map((l) => l.itemId).join()]), [['2026-07', 'a'], ['2026-08', 'a'], ['2026-09', 'b']]);
  // stara pauza uređaja bez početka — ništa za taj uređaj
  assert.deepEqual(pendingInstallments(t, [dev({ status: 'PAUSED' })], new Set(), '2026-02-02'), []);
});

// ---------------------------------------------------------------- sljedeća naplata

test('sljedeća naplata preskače izdanu ratu tekućeg razdoblja', () => {
  const t = terms({ billing: 'QUARTERLY', startDate: '2026-09-25', billingDay: null });
  assert.equal(nextBillingDate(t, [dev()], '2026-09-25'), '2026-09-25');
  assert.equal(nextBillingDate(t, [dev()], '2026-09-25', cover('a', ['2026-09'])), '2026-12-25');
  assert.equal(nextBillingDate(t, [dev({ skipped: ['2026-09'] })], '2026-09-25'), '2026-12-25');
});

// ---------------------------------------------------------------- #1/#2 izmjena uvjeta od prve neizdane rate

test('#1 uvjeti ugovora godišnje → mjesečno: godišnja rata pokriva godinu, mjesečno od sljedeće', () => {
  const oldT = terms({ billing: 'ANNUAL' });
  const newT = terms({ billing: 'MONTHLY' });
  const d = dev({ plan: [] });
  const now = '2026-09-25';
  const r = rebasePlan({ terms: oldT, nextTerms: newT, device: d, next: [], covered: new Set(['2026-01']), now });
  assert.equal(r.cut, '2027-01-01');
  assert.deepEqual(r.plan, [{ from: '2026-01-01', to: '2026-12-31', billing: 'ANNUAL', seasonFrom: 0, seasonTo: 0 }, { from: '2027-01-01' }]);
  assert.equal(validatePlan(r.plan), null);
  const after = dev({ plan: r.plan });
  assert.deepEqual(pendingInstallments(newT, [after], cover('a', ['2026-01']), now), []);
  assert.deepEqual(pendingInstallments(newT, [after], cover('a', ['2026-01']), '2027-02-05').map((p) => [p.period, p.amount]), [['2027-01', 10], ['2027-02', 10]]);
  // raspored 2026: samo izdana godišnja rata
  assert.deepEqual(contractBilling(newT, [after], 2026), [120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('#1 uvjeti ugovora: sezona i vlastiti plan uređaja zadržavaju stare uvjete do granice', () => {
  const oldT = terms({ billing: 'QUARTERLY', seasonFrom: 4, seasonTo: 10 });
  const newT = terms({ billing: 'MONTHLY', seasonFrom: null, seasonTo: null });
  const d = dev({ plan: [{ from: '2026-01-01', price: 12 }] });
  const r = rebasePlan({ terms: oldT, nextTerms: newT, device: d, next: d.plan!, covered: new Set(['2026-04', '2026-07']), now: '2026-09-25' });
  assert.equal(r.cut, '2026-10-01');
  assert.deepEqual(r.plan, [
    { from: '2026-01-01', to: '2026-09-30', price: 12, billing: 'QUARTERLY', seasonFrom: 4, seasonTo: 10 },
    { from: '2026-10-01', price: 12 },
  ]);
  assert.deepEqual(charges(newT, dev({ plan: r.plan }), '2026-01', '2026-12'), [
    ['2026-04', 36, 3], ['2026-07', 36, 3], ['2026-10', 12, 1], ['2026-11', 12, 1], ['2026-12', 12, 1],
  ]);
});

test('#1 promjena bez utjecaja na prošlost (npr. dan naplate) ne dira plan uređaja', () => {
  const r = rebasePlan({ terms: terms(), nextTerms: terms({ billingDay: 15 }), device: dev(), next: [], covered: new Set(['2026-01']), now: '2026-09-25' });
  assert.deepEqual(r, { plan: [], cut: null });
});

test('#2 plan uređaja kvartalno → mjesečno: plaćeni i pauzirani mjeseci se ne vraćaju', () => {
  const t = terms({ billing: 'QUARTERLY', startDate: '2026-02-01' });
  // veljača izdana (velj–tra), svibanj pauziran (svi–srp), kolovoz neizdan (kol–lis)
  const d = dev({ plan: [], paused: ['2026-05'] });
  const now = '2026-09-25';
  assert.equal(bulkCutoff(t, d, new Set(['2026-02']), now), '2026-11-01');
  const r = rebasePlan({ terms: t, device: d, next: [{ from: '2026-02-01', billing: 'MONTHLY' }], covered: new Set(['2026-02']), now });
  assert.equal(r.cut, '2026-11-01');
  assert.deepEqual(r.plan, [{ from: '2026-02-01', to: '2026-10-31' }, { from: '2026-11-01', billing: 'MONTHLY' }]);
  const after = dev({ plan: r.plan, paused: ['2026-05'] });
  // za izdati ostaje samo kvartalna rata za kolovoz — ne ožujak/travanj (plaćeni) ni lipanj/srpanj (pauzirani)
  assert.deepEqual(pendingInstallments(t, [after], cover('a', ['2026-02']), now).map((p) => [p.period, p.amount]), [['2026-08', 30]]);
  // raspored: veljača ostaje 30 (kao račun)
  assert.equal(contractBilling(t, [after], 2026)[1], 30);
  assert.deepEqual(pendingInstallments(t, [after], cover('a', ['2026-02', '2026-08']), '2026-12-02').map((p) => p.period), ['2026-11', '2026-12']);
});

test('#2 pauzirana buduća kvartalna rata ostaje pauzirana za sva tri mjeseca', () => {
  const t = terms({ billing: 'QUARTERLY' });
  const d = dev({ paused: ['2026-10'] });
  const r = rebasePlan({ terms: t, device: d, next: [{ from: '2026-01-01', billing: 'MONTHLY' }], covered: new Set(['2026-01', '2026-04', '2026-07']), now: '2026-09-25' });
  assert.equal(r.cut, '2027-01-01');
  const after = dev({ plan: r.plan, paused: ['2026-10'] });
  assert.deepEqual(contractAccrual(t, [after], 2026).slice(9), [0, 0, 0]);
  assert.deepEqual(deviceCharges(t, after, '2026-10', '2027-02').map((c) => c.period), ['2027-01', '2027-02']);
});

test('#2 ugovor koji još nije počeo: novi plan vrijedi u cijelosti', () => {
  const t = terms({ startDate: '2026-11-01' });
  const next = [{ from: '2026-11-01', billing: 'QUARTERLY' as const }];
  assert.deepEqual(rebasePlan({ terms: t, device: dev(), next, covered: new Set(), now: '2026-09-25' }), { plan: next, cut: null });
});

test('skupno (C6) kroz rebasePlan daje isti plan kao prije', () => {
  const t = terms({ billing: 'ANNUAL' });
  const next = applyBulkTerms([], '2026-01-01', { billing: 'MONTHLY' });
  const r = rebasePlan({ terms: t, device: dev(), next, covered: new Set(['2026-01']), now: '2026-09-25' });
  assert.deepEqual(r.plan, [{ from: '2026-01-01', to: '2026-12-31' }, { from: '2027-01-01', billing: 'MONTHLY' }]);
  const seasonal = dev({ plan: [{ from: '2025-04-01', seasonFrom: 4, seasonTo: 10 }] });
  const billed = ['2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  const r2 = rebasePlan({
    terms: terms({ startDate: '2025-04-01' }), device: seasonal, next: applyBulkTerms(seasonal.plan, '2025-04-01', { season: 'year' }), covered: new Set(billed), now: '2026-09-25',
  });
  assert.deepEqual(r2.plan, [
    { from: '2025-04-01', to: '2026-09-30', seasonFrom: 4, seasonTo: 10 },
    { from: '2026-10-01', seasonFrom: 0, seasonTo: 0 },
  ]);
});

test('bulkCutoff: sezonska rata pokriva do zadnjeg sezonskog mjeseca', () => {
  // kvartalno od veljače, sezona tra–lis: izdana veljačka rata pokriva travanj → granica svibanj (ne ožujak)
  const t = terms({ billing: 'QUARTERLY', startDate: '2026-02-01', seasonFrom: 4, seasonTo: 10 });
  assert.equal(bulkCutoff(t, dev(), new Set(['2026-02']), '2026-03-10'), '2026-05-01');
});
