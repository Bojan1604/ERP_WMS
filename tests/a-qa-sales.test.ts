/**
 * QA prodaja (t1) — čista logika: KPD po stavkama, razdoblje najma od–do, BillingReference
 * na predujam, raspodjela cijene paketa po modelu, preplata, predlošci e-pošte bez „..",
 * datumi u filtrima popisa i raspored stupaca PDF tablice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUbl, type UblInput } from '../src/domain/ubl';
import { invoiceRentMonths, kpdIssues, kpdRequired, rentLineView, rentPeriodRange } from '../src/domain/sales-lines';
import { distributePackagePrice } from '../src/domain/pricing';
import { overpaidAmount } from '../src/domain/invoice';
import { fillTemplate } from '../src/domain/mail';
import { isIsoDate, parseDateRange } from '../src/lib/list-params';
import { layoutColumns, tableDocDefinition } from '../src/server/pdf/table';

const base: UblInput = {
  kind: 'INVOICE',
  type: 'SALE',
  number: '20/PP1/1',
  issueDate: '2026-09-20',
  dueDate: '2026-10-05',
  seller: { name: 'Demo d.o.o.', oib: '12345678903', address: 'Ilica 1', zip: '10000', city: 'Zagreb', country: 'HR', iban: 'HR1210010051863000160', vatRegistered: true },
  buyer: { name: 'Kupac d.o.o.', oib: '69435151530', address: 'Riva 2', zip: '21000', city: 'Split', country: 'HR' },
  vatRate: 25,
  lines: [{ description: 'Usluga', kpd: '62.09.20', unit: 'kom', qty: 1, unitPrice: 100 }],
};

test('KPD: nedostaje ili nije oblika NN.NN.NN — poruka po stavci; koji dokumenti ga traže', () => {
  assert.deepEqual(kpdIssues([{ description: 'A', kpd: '26.20.16' }]), []);
  const out = kpdIssues([
    { description: 'Ručna', kpd: null },
    { description: 'Krivo', kpd: '99.9' },
    { description: 'Slova', kpd: 'ab.cd.ef' },
  ]);
  assert.equal(out.length, 3);
  assert.match(out[0], /Stavka 1 \(Ručna\) nema KPD/);
  assert.match(out[1], /Stavka 2 .*„99\.9" nije oblika NN\.NN\.NN/);
  assert.match(out[2], /Stavka 3/);
  assert.equal(kpdRequired('INVOICE'), true);
  assert.equal(kpdRequired('STORNO', 'INVOICE'), true);
  assert.equal(kpdRequired('STORNO', 'ADVANCE'), false);
  assert.equal(kpdRequired('ADVANCE'), false);
  assert.equal(kpdRequired('CREDIT_NOTE'), false);
});

test('najam: kvartalna rata pokriva 3 mjeseca — razdoblje od–do u UBL-u, stavka „kom" s razdobljem', () => {
  assert.equal(invoiceRentMonths([{ months: 3 }, { months: null }]), 3);
  assert.equal(invoiceRentMonths([]), 1);
  assert.deepEqual(rentPeriodRange('2026-09', 3), { from: '2026-09-01', to: '2026-11-30', label: '09/2026 – 11/2026' });
  assert.deepEqual(rentPeriodRange('2026-12', 3), { from: '2026-12-01', to: '2027-02-28', label: '12/2026 – 02/2027' });
  assert.equal(rentPeriodRange('2026-09', 1)?.label, '09/2026');
  assert.equal(rentPeriodRange('2026-13', 1), null);

  const v = rentLineView({ description: 'Najam Sunmi T2s', unit: 'mj', monthly: 89, months: 3 }, rentPeriodRange('2026-09', 3));
  assert.equal(v.unit, 'kom');
  assert.equal(v.description, 'Najam Sunmi T2s — 09/2026 – 11/2026');
  assert.match(v.note ?? '', /3 mj × 89,00 €\/mj po uređaju/);
  // stavka koja nije najam ostaje kakva jest
  assert.deepEqual(rentLineView({ description: 'Usluga', unit: 'sat' }, null), { description: 'Usluga', unit: 'sat', note: null });

  const { xml } = buildUbl({ ...base, type: 'RENT', period: '2026-09', periodMonths: 3 });
  assert.match(xml, /<cac:InvoicePeriod><cbc:StartDate>2026-09-01<\/cbc:StartDate><cbc:EndDate>2026-11-30<\/cbc:EndDate>/);
});

test('konačni račun s uračunatim predujmom: P11 i BillingReference na svaki predujam', () => {
  const { xml, totals } = buildUbl({ ...base, advanceAmount: 50, advanceReferences: [{ number: '5/PP1/1', date: '2026-09-01' }, { number: '7/PP1/1', date: '2026-09-10' }] });
  assert.equal(totals.profile, 'P11');
  assert.equal(totals.prepaid, 50);
  assert.equal(totals.payable, 75);
  const refs = [...xml.matchAll(/<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>([^<]+)<\/cbc:ID><cbc:IssueDate>([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(refs, [
    ['5/PP1/1', '2026-09-01'],
    ['7/PP1/1', '2026-09-10'],
  ]);
  // predujam sam nema BillingReference na predujmove
  assert.doesNotMatch(buildUbl({ ...base, kind: 'ADVANCE', advanceReferences: [{ number: 'X' }] }).xml, /BillingReference/);
});

test('isporuka unutar EU (oznaka K) ide u UBL kao E s razlogom — kao izvorni program i primjeri CIUS-2025', () => {
  const { xml, totals } = buildUbl({ ...base, taxCategory: 'K', exemptReason: 'Oslobođeno PDV-a — čl. 41. st. 1. t. a) Zakona o PDV-u', vatRate: 0 });
  assert.equal(totals.category, 'E');
  assert.match(xml, /<cbc:TaxExemptionReason>Oslobođeno PDV-a — čl\. 41/);
});

test('paket: isti model dobiva istu cijenu, zbroj je točno cijena paketa', () => {
  // dva ista uređaja s različitom preporučenom cijenom (marža iz različite nabavne) i treći model
  const p = distributePackagePrice([657.31, 637.81, 300], 1500, ['m1', 'm1', 'm2']);
  assert.equal(p[0], p[1]);
  assert.equal(Math.round(p.reduce((a, b) => a + b, 0) * 100) / 100, 1500);
  // bez cijene paketa: prosjek preporučenih po modelu
  assert.deepEqual(distributePackagePrice([100, 120], null, ['m', 'm']), [110, 110]);
  // zaokruživanje ide na model koji je u paketu jednom
  const q = distributePackagePrice([1, 1, 1], 100, ['a', 'a', 'b']);
  assert.equal(q[0], q[1]);
  assert.equal(Math.round((q[0] + q[1] + q[2]) * 100) / 100, 100);
});

test('preplata: odobrenje na plaćeni račun daje iznos za povrat kupcu', () => {
  assert.equal(overpaidAmount({ kind: 'INVOICE', stornoed: false, total: 125, advance: 0, paid: 125, credited: 25 }), 25);
  assert.equal(overpaidAmount({ kind: 'INVOICE', stornoed: false, total: 125, advance: 50, paid: 75, credited: 0 }), 0);
  assert.equal(overpaidAmount({ kind: 'CREDIT_NOTE', stornoed: false, total: -25, advance: 0, paid: 0, credited: 0 }), 0);
  assert.equal(overpaidAmount({ kind: 'INVOICE', stornoed: true, total: 125, advance: 0, paid: 125, credited: 25 }), 0);
});

test('predložak e-pošte: datum ispred točke bez dvostruke točke', () => {
  assert.equal(fillTemplate('s rokom plaćanja {dospijece}.\nIznos: {iznos}.', { dospijece: '25.09.2026.', iznos: '10,00 €' }), 's rokom plaćanja 25.09.2026.\nIznos: 10,00 €.');
  assert.equal(fillTemplate('{rok}!', { dospijece: '25.09.2026.' }), '25.09.2026.!');
});

test('filtri popisa: neispravan datum se zanemaruje, obrnut raspon se okreće', () => {
  assert.equal(isIsoDate('2026-13-45'), false);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.deepEqual(parseDateRange(new URLSearchParams('od=2026-01-01&do=2026-13-45')), { from: '2026-01-01', to: null });
  assert.deepEqual(parseDateRange(new URLSearchParams('od=2026-05-01&do=2026-01-01')), { from: '2026-01-01', to: '2026-05-01' });
});

test('PDF tablica: 22 stupca stanu u širinu stranice (manji font / prijelom), inače se dijele', () => {
  const heads = Array.from({ length: 22 }, (_, i) => `Stupac broj ${i + 1}`);
  const row = heads.map((_, i) => (i % 3 === 0 ? '12.345,67' : i % 3 === 1 ? '25.09.2026.' : 'Hostel Sunce d.o.o. Split — SN-EPSONTMM30III-100001'));
  const wrap = heads.map((_, i) => i % 3 === 2);
  const width = 841.89 - 48;
  const l = layoutColumns(heads, [row, row], wrap, width);
  assert.equal(l.chunks.length, 1);
  assert.ok(l.fontSize <= 8 && l.fontSize >= 5.5);
  assert.equal(l.chunks[0].cols.length, 22);
  // širine + razmak ćelija ne prelaze širinu stranice
  assert.ok(l.chunks[0].widths.reduce((a, w) => a + w + 4, 0) <= width + 0.5);
  // 60 stupaca ne stane ni uz najmanji font — više tablica, prvi stupac se ponavlja, svi stupci su prikazani
  const many = Array.from({ length: 60 }, (_, i) => `Iznos ${i}`);
  const m = layoutColumns(many, [many.map(() => '1.234.567,89')], many.map(() => false), width);
  assert.ok(m.chunks.length > 1);
  assert.ok(m.chunks.every((c) => c.cols[0] === 0));
  assert.equal(new Set(m.chunks.flatMap((c) => c.cols)).size, 60);
  for (const c of m.chunks) assert.ok(c.widths.reduce((a, w) => a + w + 4, 0) <= width + 0.5);

  // definicija: ležeći A4 i zadane širine za svaki stupac
  const def = tableDocDefinition({ title: 'T', columns: heads.map((h, i) => ({ label: h, value: () => row[i] })), rows: [1, 2] });
  assert.equal(def.pageOrientation, 'landscape');
});
