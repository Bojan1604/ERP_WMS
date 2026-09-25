/** Prodaja — ispravci nakon pregleda koda: porezni tretman po vrsti isporuke, čl. 90., pravo slanja partneru. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignInvoiceVat,
  customerVat,
  EXEMPT_DEFAULTS,
  mixedSupplyError,
  NOT_REGISTERED_NOTE,
  NOT_REGISTERED_REASON,
  supplyKindOf,
  taxNotes,
} from '../src/domain/tax';
import { ublTreatment } from '../src/domain/ubl';
import { MAIL_KIND_ACCESS } from '../src/domain/documents';

const firm = { vatRegistered: true, vatRate: 25, country: 'HR' };

test('strani kupac: roba i usluga imaju različitu osnovu (čl. 41./45. naspram čl. 17.)', () => {
  const eu = { country: 'DE', vatCategoryOverride: null };
  const us = { country: 'US', vatCategoryOverride: null };
  assert.deepEqual([customerVat(eu, firm, 'SALE').category, customerVat(eu, firm, 'SALE').exemptReason], ['K', EXEMPT_DEFAULTS.euGoods]);
  // najam i servis kupcu u EU: prijenos porezne obveze po čl. 17., ne isporuka dobara po čl. 41.
  for (const k of ['RENT', 'SERVICE'] as const) {
    const t = customerVat(eu, firm, k);
    assert.equal(t.category, 'AE');
    assert.equal(t.exemptReason, EXEMPT_DEFAULTS.euService);
    assert.doesNotMatch(t.exemptReason!, /čl\. 41/);
  }
  assert.deepEqual([customerVat(us, firm, 'SALE').category, customerVat(us, firm, 'SALE').exemptReason], ['G', EXEMPT_DEFAULTS.thirdGoods]);
  assert.deepEqual([customerVat(us, firm, 'RENT').category, customerVat(us, firm, 'RENT').exemptReason], ['E', EXEMPT_DEFAULTS.thirdService]);
  // vlastiti tekst firme (Postavke → Firma) ima prednost
  assert.equal(customerVat(eu, { ...firm, vatTextEuService: 'Reverse charge — čl. 17. st. 1.' }, 'RENT').exemptReason, 'Reverse charge — čl. 17. st. 1.');
  // domaći kupac i ručna kategorija partnera ne ovise o vrsti
  assert.equal(customerVat('HR', firm, 'RENT').category, 'S');
  assert.equal(customerVat({ country: 'DE', vatCategoryOverride: 'O' }, firm, 'RENT').category, 'O');
});

test('vrsta isporuke računa i miješani račun stranom kupcu', () => {
  assert.equal(supplyKindOf('SALE', []), 'SALE');
  assert.equal(supplyKindOf('RENT', [{ lineType: null }]), 'RENT');
  assert.equal(supplyKindOf('SALE', [{ lineType: null }, { lineType: 'RENT' }]), 'MIXED');
  assert.equal(supplyKindOf('SALE', [{ lineType: 'RENT' }]), 'RENT');
  assert.equal(supplyKindOf('SERVICE', [{ lineType: null }]), 'SERVICE');

  const eu = { country: 'AT', vatCategoryOverride: null };
  assert.match(mixedSupplyError(eu, firm, 'K', 'MIXED') ?? '', /zasebnim računima/);
  assert.match(mixedSupplyError({ country: 'US', vatCategoryOverride: null }, firm, 'G', 'MIXED') ?? '', /zasebnim računima/);
  // isti tretman za sve stavke: domaći, standardna stopa, ručna kategorija, firma izvan sustava PDV-a
  assert.equal(mixedSupplyError({ country: 'HR', vatCategoryOverride: null }, firm, 'S', 'MIXED'), null);
  assert.equal(mixedSupplyError(eu, firm, 'S', 'MIXED'), null);
  assert.equal(mixedSupplyError({ country: 'AT', vatCategoryOverride: 'AE' }, firm, 'AE', 'MIXED'), null);
  assert.equal(mixedSupplyError(eu, { ...firm, vatRegistered: false }, 'O', 'MIXED'), null);
  assert.equal(mixedSupplyError(eu, firm, 'K', 'SALE'), null);
});

test('usklađivanje tretmana nacrta s vrstom računa: automatski se ispravlja, ručni ostaje', () => {
  const eu = { country: 'DE', vatCategoryOverride: null };
  // najam s tretmanom robe (stari zadani tekst) → AE i čl. 17.
  assert.deepEqual(alignInvoiceVat(eu, firm, 'RENT', { taxCategory: 'K', taxExemptReason: 'Oslobođeno PDV-a — isporuka unutar EU (čl. 41. Zakona o PDV-u)' }), {
    taxCategory: 'AE',
    taxExemptReason: EXEMPT_DEFAULTS.euService,
  });
  assert.deepEqual(alignInvoiceVat(eu, firm, 'RENT', { taxCategory: 'K', taxExemptReason: EXEMPT_DEFAULTS.euGoods }).taxCategory, 'AE');
  // ručno upisan razlog ili standardna stopa se ne diraju
  const manual = { taxCategory: 'E', taxExemptReason: 'Oslobođeno prema čl. 39.' };
  assert.deepEqual(alignInvoiceVat(eu, firm, 'RENT', manual), manual);
  assert.deepEqual(alignInvoiceVat(eu, firm, 'RENT', { taxCategory: 'S', taxExemptReason: null }), { taxCategory: 'S', taxExemptReason: null });
  // roba ostaje roba; vlastiti tekst firme zamjenjuje zadani
  assert.deepEqual(alignInvoiceVat(eu, { ...firm, vatTextEuGoods: 'Isporuka unutar EU' }, 'SALE', { taxCategory: 'K', taxExemptReason: EXEMPT_DEFAULTS.euGoods }), {
    taxCategory: 'K',
    taxExemptReason: 'Isporuka unutar EU',
  });
  // domaći kupac i ručna kategorija partnera
  assert.deepEqual(alignInvoiceVat('HR', firm, 'RENT', { taxCategory: 'AE', taxExemptReason: null }), { taxCategory: 'AE', taxExemptReason: null });
  assert.deepEqual(alignInvoiceVat({ country: 'DE', vatCategoryOverride: 'E' }, firm, 'RENT', { taxCategory: 'E', taxExemptReason: 'Oslobođeno PDV-a' }).taxCategory, 'E');
});

test('firma izvan sustava PDV-a: jedna osnova (čl. 90. st. 2.) na računu, ispisu i u eRačunu', () => {
  const t = customerVat('HR', { ...firm, vatRegistered: false });
  assert.equal(t.exemptReason, NOT_REGISTERED_REASON);
  assert.match(t.exemptReason!, /čl\. 90\. st\. 2\./);
  // ispis: bez dvostruke (i različite) osnove
  assert.deepEqual(taxNotes({ taxCategory: 'O', taxExemptReason: t.exemptReason! }, false), [NOT_REGISTERED_NOTE]);
  assert.deepEqual(taxNotes({ taxCategory: 'O', taxExemptReason: 'Obveznik nije u sustavu PDV-a (čl. 90. st. 1. Zakona o PDV-u)' }, false), [NOT_REGISTERED_NOTE]);
  assert.deepEqual(taxNotes({ taxCategory: 'AE', taxExemptReason: 'Prijenos' }, true), ['Prijenos']);
  assert.deepEqual(taxNotes({ taxCategory: 'S', taxExemptReason: 'x' }, true), []);
  // eRačun: stariji razlog s čl. 90. st. 1. ide kao st. 2.
  const seller = { name: 'Obrt', oib: '12345678903', vatRegistered: false } as Parameters<typeof ublTreatment>[0]['seller'];
  assert.equal(ublTreatment({ taxCategory: 'O', exemptReason: 'Obveznik nije u sustavu PDV-a (čl. 90. st. 1. Zakona o PDV-u)', vatRate: 0, seller }).reason, NOT_REGISTERED_REASON);
  assert.equal(ublTreatment({ taxCategory: 'O', exemptReason: null, vatRate: 0, seller }).reason, NOT_REGISTERED_REASON);
});

test('slobodna e-poruka partneru traži pravo uređivanja partnera', () => {
  assert.deepEqual(MAIL_KIND_ACCESS.partner, { module: 'partners', level: 'edit' });
});
