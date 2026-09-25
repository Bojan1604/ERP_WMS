/** Područje C: skupna sezona/naplata na planu uređaja, ručna PDV kategorija partnera, eRačun adresa. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBulkTerms, validatePlan } from '../src/domain/plan';
import { customerVat, isVatOverride } from '../src/domain/tax';
import { buildUbl, parseEndpoint } from '../src/domain/ubl';

test('applyBulkTerms: sezona i naplata na planu uređaja', () => {
  const base = '2026-01-01';
  // prazan plan → jedno razdoblje od početka naplate
  assert.deepEqual(applyBulkTerms([], base, { season: 'summer' }), [{ from: base, seasonFrom: 4, seasonTo: 10 }]);
  assert.deepEqual(applyBulkTerms(null, base, { billing: 'QUARTERLY', season: 'year' }), [{ from: base, billing: 'QUARTERLY', seasonFrom: 0, seasonTo: 0 }]);
  // „kao na ugovoru" na jednom razdoblju briše i vlastitu naplatu → prazan plan
  assert.deepEqual(applyBulkTerms([{ from: base, billing: 'ANNUAL', seasonFrom: 4, seasonTo: 10 }], base, { season: 'contract' }), []);
  // …osim ako je naplata zadana u istom koraku
  assert.deepEqual(applyBulkTerms([{ from: base, seasonFrom: 4, seasonTo: 10 }], base, { season: 'contract', billing: 'MONTHLY' }), [{ from: base, billing: 'MONTHLY' }]);
  // vlastita cijena ili kasniji početak ostaju
  assert.deepEqual(applyBulkTerms([{ from: '2026-03-01', price: 9 }], base, { season: 'contract' }), [{ from: '2026-03-01', price: 9 }]);
  // više razdoblja: izmjena vrijedi za sva, prijelaz naplate ostaje
  const plan = [
    { from: base, billing: 'MONTHLY' as const },
    { from: '2026-07-01', billing: 'QUARTERLY' as const },
  ];
  const out = applyBulkTerms(plan, base, { season: 'summer' });
  assert.equal(out.length, 2);
  assert.ok(out.every((p) => p.seasonFrom === 4 && p.seasonTo === 10));
  assert.deepEqual(out.map((p) => p.billing), ['MONTHLY', 'QUARTERLY']);
  assert.equal(validatePlan(out), null);
  // ulaz se ne mijenja
  assert.equal(plan[0].billing, 'MONTHLY');
  assert.equal((plan[0] as { seasonFrom?: number }).seasonFrom, undefined);
});

test('customerVat: ručna kategorija partnera nadjačava državu', () => {
  const firm = { vatRegistered: true, vatRate: 25, country: 'HR' };
  assert.equal(customerVat('HR', firm).category, 'S');
  assert.equal(customerVat({ country: 'HR', vatCategoryOverride: null }, firm).category, 'S');
  const ae = customerVat({ country: 'HR', vatCategoryOverride: 'AE' }, firm);
  assert.equal(ae.category, 'AE');
  assert.equal(ae.rate, 0);
  assert.match(ae.exemptReason ?? '', /čl\. 17/);
  assert.equal(customerVat({ country: 'DE', vatCategoryOverride: 'S' }, firm).rate, 25);
  assert.equal(customerVat({ country: 'DE', vatCategoryOverride: 'Z' }, firm).category, 'Z');
  assert.equal(customerVat({ country: 'US', vatCategoryOverride: 'E' }, firm).category, 'E');
  // nepoznata oznaka se zanemaruje
  assert.equal(customerVat({ country: 'DE', vatCategoryOverride: 'X' }, firm).category, 'K');
  // firma izvan sustava PDV-a ne može obračunati standardnu stopu
  assert.equal(customerVat({ country: 'HR', vatCategoryOverride: 'S' }, { ...firm, vatRegistered: false }).category, 'O');
  assert.ok(isVatOverride('O') && !isVatOverride('K'));
});

test('parseEndpoint i UBL stranka kupca', () => {
  assert.deepEqual(parseEndpoint('9934:12345678903'), { scheme: '9934', id: '12345678903' });
  assert.deepEqual(parseEndpoint('0088:5790000435951'), { scheme: '0088', id: '5790000435951' });
  assert.deepEqual(parseEndpoint('12345678903'), { scheme: '9934', id: '12345678903' });
  assert.equal(parseEndpoint('  '), null);
  const input = {
    kind: 'INVOICE' as const,
    number: '1/T1/1',
    issueDate: '2026-05-01',
    seller: { name: 'Firma', oib: '12345678903', country: 'HR' },
    vatRate: 25,
    lines: [{ description: 'Najam', qty: 1, unitPrice: 10 }],
  };
  const foreign = buildUbl({ ...input, buyer: { name: 'GmbH', vatId: 'DE123456789', country: 'DE', endpointId: '9930:DE123456789' } }).xml;
  assert.match(foreign, /<cbc:EndpointID schemeID="9930">DE123456789<\/cbc:EndpointID>/);
  // strani kupac bez adrese nema EndpointID ni poslovnicu
  const plain = buildUbl({ ...input, buyer: { name: 'GmbH', vatId: 'DE123456789', country: 'DE', branchCode: 'X1' } }).xml;
  const cust = plain.split('<cac:AccountingCustomerParty>')[1];
  assert.doesNotMatch(cust.split('</cac:AccountingCustomerParty>')[0], /EndpointID|PartyIdentification/);
  const branch = buildUbl({ ...input, buyer: { name: 'Kupac', oib: '69435151530', country: 'HR', branchCode: 'PJ1', branchName: 'Poslovnica <1>' } }).xml;
  assert.match(branch, /<cbc:ID>9934:69435151530::HR99:PJ1<\/cbc:ID>/);
  assert.match(branch, /<cbc:Name>Poslovnica &lt;1&gt;<\/cbc:Name>/);
});
