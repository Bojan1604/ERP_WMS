/** Čitanje primljenog eRačuna (UBL Invoice / CreditNote, HR CIUS-2025). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUbl, type UblInput } from '../src/domain/ubl';
import { oibFrom, parseUbl, signedAmounts, ublPdf } from '../src/domain/ubl-parse';

const seller = {
  name: 'Distributer POS d.o.o.',
  oib: '69435151530',
  address: 'Savska 100',
  zip: '10000',
  city: 'Zagreb',
  country: 'HR',
  iban: 'HR1723600001101234565',
  vatRegistered: true,
};
const buyer = { name: 'Demo Oprema d.o.o.', oib: '12345678903', address: 'Ilica 1', zip: '10000', city: 'Zagreb', country: 'HR' };

const base: UblInput = {
  kind: 'INVOICE',
  type: 'SALE',
  number: 'R-2041/1/1',
  issueDate: '2026-03-05',
  issueTime: '10:15:00',
  dueDate: '2026-03-20',
  seller,
  buyer,
  vatRate: 25,
  taxCategory: 'S',
  lines: [
    { description: 'POS terminal', kpd: '26.20.16', unit: 'kom', qty: 4, unitPrice: 180 },
    { description: 'Dostava', kpd: '49.41.19', unit: 'kom', qty: 1, unitPrice: 20 },
  ],
};

test('HR CIUS račun: broj, datumi, dobavljač (9934), kupac, zbrojevi, valuta', () => {
  const { xml, totals } = buildUbl(base);
  const p = parseUbl(xml)!;
  assert.ok(p);
  assert.equal(p.root, 'Invoice');
  assert.equal(p.credit, false);
  assert.equal(p.typeCode, '380');
  assert.equal(p.number, 'R-2041/1/1');
  assert.equal(p.issueDate, '2026-03-05');
  assert.equal(p.dueDate, '2026-03-20');
  assert.equal(p.currency, 'EUR');
  assert.equal(p.supplier.name, 'Distributer POS d.o.o.');
  assert.equal(p.supplier.oib, '69435151530');
  assert.equal(p.supplier.vatId, 'HR69435151530');
  assert.equal(p.supplier.city, 'Zagreb');
  assert.equal(p.supplier.country, 'HR');
  assert.equal(p.customer.oib, '12345678903');
  assert.equal(p.net, 740);
  assert.equal(p.vat, 185);
  assert.equal(p.total, 925);
  assert.equal(p.payable, totals.payable);
  assert.deepEqual(p.attachments, []);
});

test('broj nije porezna kategorija iz HR proširenja (UBLExtensions ima <cbc:ID>)', () => {
  // kategorija E → HR proširenje s HRTaxCategory/ID prije broja računa
  const { xml } = buildUbl({ ...base, taxCategory: 'E', exemptReason: 'Oslobođeno', number: '99-X' });
  assert.match(xml, /HRFISK20Data/);
  const p = parseUbl(xml)!;
  assert.equal(p.number, '99-X');
  assert.equal(p.vat, 0);
});

test('knjižno odobrenje (CreditNote 381): negativni iznosi u knjizi URA', () => {
  const { xml } = buildUbl({ ...base, kind: 'CREDIT_NOTE', number: 'OD-7', billingReference: { number: 'R-2041/1/1', date: '2026-03-05' } });
  const p = parseUbl(xml)!;
  assert.equal(p.root, 'CreditNote');
  assert.equal(p.credit, true);
  assert.equal(p.number, 'OD-7');
  // odobrenje u knjizi URA uvijek umanjuje obvezu, bez obzira na predznak u XML-u
  assert.deepEqual(signedAmounts(p), { net: -740, vat: -185, total: -925 });
  // storno (384) već nosi negativne iznose — ostaju takvi
  assert.deepEqual(signedAmounts({ credit: false, net: -10, vat: -2.5, total: -12.5 }), { net: -10, vat: -2.5, total: -12.5 });
  assert.deepEqual(signedAmounts({ credit: true, net: 0, vat: 0, total: 0 }), { net: 0, vat: 0, total: 0 });
});

test('ugrađeni PDF (AdditionalDocumentReference / EmbeddedDocumentBinaryObject)', () => {
  const pdf = Buffer.from('%PDF-1.4\n%demo\n').toString('base64');
  const { xml } = buildUbl(base);
  const withPdf = xml.replace(
    '  <cac:AccountingSupplierParty>',
    `  <cac:AdditionalDocumentReference>
    <cbc:ID>racun.pdf</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="R-2041.pdf">${pdf.slice(0, 8)}
        ${pdf.slice(8)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>`,
  );
  const p = parseUbl(withPdf)!;
  assert.equal(p.attachments.length, 1);
  const a = ublPdf(p)!;
  assert.equal(a.fileName, 'R-2041.pdf');
  assert.equal(a.mime, 'application/pdf');
  assert.equal(a.base64, pdf, 'razmaci i novi redovi se uklanjaju');
  assert.equal(Buffer.from(a.base64, 'base64').toString().slice(0, 5), '%PDF-');
});

test('drugi prefiksi imenskih prostora, OIB samo u PDV ID-u, dospijeće u PaymentMeans', () => {
  const xml = `<?xml version="1.0"?>
<inv:Invoice xmlns:inv="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:a="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:b="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <b:ID>INV 5</b:ID>
  <b:IssueDate>2026-01-02</b:IssueDate>
  <b:InvoiceTypeCode>380</b:InvoiceTypeCode>
  <b:Note>Prva napomena</b:Note>
  <b:DocumentCurrencyCode>EUR</b:DocumentCurrencyCode>
  <a:AccountingSupplierParty><a:Party>
    <b:EndpointID schemeID="0088">3838000000001</b:EndpointID>
    <a:PartyName><b:Name>Samo Naziv</b:Name></a:PartyName>
    <a:PartyTaxScheme><b:CompanyID>HR84123456785</b:CompanyID><a:TaxScheme><b:ID>VAT</b:ID></a:TaxScheme></a:PartyTaxScheme>
  </a:Party></a:AccountingSupplierParty>
  <a:PaymentMeans><b:PaymentMeansCode>30</b:PaymentMeansCode><b:PaymentDueDate>2026-01-17</b:PaymentDueDate></a:PaymentMeans>
  <a:TaxTotal><b:TaxAmount currencyID="EUR">2,50</b:TaxAmount></a:TaxTotal>
  <a:LegalMonetaryTotal><b:TaxExclusiveAmount currencyID="EUR">10.00</b:TaxExclusiveAmount><b:PayableAmount currencyID="EUR">12.50</b:PayableAmount></a:LegalMonetaryTotal>
</inv:Invoice>`;
  const p = parseUbl(xml)!;
  assert.equal(p.number, 'INV 5');
  assert.equal(p.supplier.name, 'Samo Naziv');
  assert.equal(p.supplier.oib, '84123456785', 'GLN iz EndpointID (0088) nije OIB');
  assert.equal(p.dueDate, '2026-01-17');
  assert.equal(p.vat, 2.5);
  assert.equal(p.total, 12.5, 'bez TaxInclusiveAmount: osnovica + PDV');
  assert.equal(p.payable, 12.5);
  assert.equal(p.note, 'Prva napomena');
});

test('neispravan ulaz → null', () => {
  assert.equal(parseUbl(''), null);
  assert.equal(parseUbl('nije xml'), null);
  assert.equal(parseUbl('<Order><ID>1</ID></Order>'), null);
  assert.equal(parseUbl('<Invoice><ID>1</Invoice'), null);
});

test('OIB iz identifikatora', () => {
  assert.equal(oibFrom('HR69435151530'), '69435151530');
  assert.equal(oibFrom('9934:69435151530'), '69435151530');
  assert.equal(oibFrom(' 69435151530 '), '69435151530');
  assert.equal(oibFrom('SI12345678'), '');
  assert.equal(oibFrom('3838000000001'), '');
});
