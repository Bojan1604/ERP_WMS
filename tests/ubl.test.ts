import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUbl, unitCode, ublTreatment, xmlEscape, type UblInput } from '../src/domain/ubl';

const seller = {
  name: 'Demo Oprema d.o.o.',
  oib: '12345678903',
  address: 'Ilica 1',
  zip: '10000',
  city: 'Zagreb',
  country: 'HR',
  iban: 'HR12 1001 0051 8630 0016 0',
  vatRegistered: true,
};
const buyer = { name: 'Caffe <Bar> & "Mandrać"', oib: '69435151530', address: 'Riva 2', zip: '21000', city: 'Split', country: 'HR' };

const base: UblInput = {
  kind: 'INVOICE',
  type: 'SALE',
  number: '12/PP1/1',
  issueDate: '2026-03-05',
  issueTime: '10:15:00',
  dueDate: '2026-03-20',
  seller,
  operator: { name: 'Ana Anić', oib: '12345678903' },
  buyer,
  vatRate: 25,
  taxCategory: 'S',
  discountPct: 10,
  discountAmount: 5,
  paymentReference: '12-2026',
  lines: [
    { description: 'Epson TM-T20III', serial: 'SN-001', kpd: '26.20.16', unit: 'kom', qty: 2, unitPrice: 100, discountPct: 10 },
    { description: 'Instalacija', kpd: '62.09.20', unit: 'sat', qty: 1, unitPrice: 50 },
  ],
};

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return m?.[1];
};

test('račun 380: zaglavlje, stranke, plaćanje i KPD', () => {
  const { xml, root, totals, fileName } = buildUbl(base);
  assert.equal(root, 'Invoice');
  assert.equal(fileName, 'eRacun-12-PP1-1.xml');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.equal(tag(xml, 'cbc:InvoiceTypeCode'), '380');
  assert.equal(tag(xml, 'cbc:ProfileID'), 'P1');
  assert.match(xml, /urn:mfin\.gov\.hr:cius-2025:1\.0/);
  assert.equal(tag(xml, 'cbc:ID'), '12/PP1/1');
  assert.equal(tag(xml, 'cbc:DueDate'), '2026-03-20');
  assert.match(xml, /<cbc:EndpointID schemeID="9934">12345678903<\/cbc:EndpointID>/);
  assert.match(xml, /<cbc:EndpointID schemeID="9934">69435151530<\/cbc:EndpointID>/);
  assert.match(xml, /<cbc:CompanyID>HR12345678903<\/cbc:CompanyID>/);
  assert.match(xml, /<cbc:CompanyID>HR69435151530<\/cbc:CompanyID>/);
  assert.equal(tag(xml, 'cbc:PaymentMeansCode'), '30');
  assert.equal(tag(xml, 'cbc:PaymentID'), 'HR00 12-2026');
  assert.match(xml, /<cac:PayeeFinancialAccount><cbc:ID>HR1210010051863000160<\/cbc:ID>/);
  assert.match(xml, /<cbc:ItemClassificationCode listID="CG">26\.20\.16<\/cbc:ItemClassificationCode>/);
  assert.match(xml, /<cbc:InvoicedQuantity unitCode="HUR">1\.000<\/cbc:InvoicedQuantity>/);
  assert.match(xml, /<cac:SellerContact><cbc:ID>12345678903<\/cbc:ID><cbc:Name>Ana Anić<\/cbc:Name>/);
  assert.match(xml, /<cbc:Name>HR:PDV25<\/cbc:Name>/);
  // nema hrvatskog proširenja za obični PDV
  assert.doesNotMatch(xml, /HRFISK20Data/);
  assert.equal(totals.total, 252.5);
});

test('zbrojevi: popust po stavci i na dokument, PDV i LegalMonetaryTotal', () => {
  const { xml, totals } = buildUbl(base);
  // stavke: 2 × 100 × 0,9 = 180 + 50 = 230; popust 10 % + 5 = 28; osnovica 202; PDV 50,50
  assert.equal(totals.lines, 230);
  assert.equal(totals.discount, 28);
  assert.equal(totals.net, 202);
  assert.equal(totals.vat, 50.5);
  assert.equal(totals.total, 252.5);
  assert.equal(totals.payable, 252.5);
  assert.match(xml, /<cbc:LineExtensionAmount currencyID="EUR">230\.00<\/cbc:LineExtensionAmount>\n    <cbc:TaxExclusiveAmount currencyID="EUR">202\.00/);
  assert.match(xml, /<cbc:TaxInclusiveAmount currencyID="EUR">252\.50<\/cbc:TaxInclusiveAmount>/);
  assert.match(xml, /<cbc:AllowanceTotalAmount currencyID="EUR">28\.00<\/cbc:AllowanceTotalAmount>/);
  assert.match(xml, /<cbc:PayableAmount currencyID="EUR">252\.50<\/cbc:PayableAmount>/);
  assert.match(xml, /<cac:TaxTotal>\n    <cbc:TaxAmount currencyID="EUR">50\.50<\/cbc:TaxAmount>/);
  // popust na dokument kao AllowanceCharge
  assert.match(xml, /<cbc:ChargeIndicator>false<\/cbc:ChargeIndicator>\n    <cbc:AllowanceChargeReason>Popust<\/cbc:AllowanceChargeReason>/);
  // popust na stavci u cijeni: neto cijena 90, osnovna 100
  assert.match(xml, /<cbc:PriceAmount currencyID="EUR">90\.000000<\/cbc:PriceAmount>/);
  assert.match(xml, /<cbc:BaseAmount currencyID="EUR">100\.000000<\/cbc:BaseAmount>/);
  assert.match(xml, /<cbc:LineExtensionAmount currencyID="EUR">180\.00<\/cbc:LineExtensionAmount>/);
});

test('escape posebnih znakova', () => {
  const { xml } = buildUbl(base);
  assert.match(xml, /Caffe &lt;Bar&gt; &amp; &quot;Mandrać&quot;/);
  assert.doesNotMatch(xml, /<Bar>/);
  assert.equal(xmlEscape(`a<b>&'"`), 'a&lt;b&gt;&amp;&apos;&quot;');
});

test('valuta u atributu currencyID se escapira (obrana i za neispravnu vrijednost u bazi)', () => {
  const { xml } = buildUbl({ ...base, currency: 'EUR"><x a="' });
  assert.doesNotMatch(xml, /currencyID="EUR"><x/);
  assert.match(xml, /currencyID="EUR&quot;&gt;&lt;x a=&quot;"/);
  assert.match(xml, /<cbc:DocumentCurrencyCode>EUR&quot;&gt;&lt;x a=&quot;<\/cbc:DocumentCurrencyCode>/);
});

test('storno 384: negativni iznosi i veza na izvorni račun', () => {
  const { xml, totals } = buildUbl({
    ...base,
    kind: 'STORNO',
    number: '13/PP1/1',
    discountPct: 0,
    discountAmount: 0,
    lines: [{ description: 'Epson TM-T20III', kpd: '26.20.16', qty: -1, unitPrice: 200 }],
    billingReference: { number: '12/PP1/1', date: '2026-03-05', kind: 'INVOICE' },
  });
  assert.equal(tag(xml, 'cbc:InvoiceTypeCode'), '384');
  assert.equal(tag(xml, 'cbc:ProfileID'), 'P10');
  assert.match(xml, /<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>12\/PP1\/1<\/cbc:ID><cbc:IssueDate>2026-03-05<\/cbc:IssueDate>/);
  assert.match(xml, /<cbc:InvoicedQuantity unitCode="H87">-1\.000<\/cbc:InvoicedQuantity>/);
  assert.match(xml, /<cbc:PriceAmount currencyID="EUR">200\.000000<\/cbc:PriceAmount>/);
  assert.equal(totals.total, -250);
  assert.match(xml, /<cbc:PayableAmount currencyID="EUR">-250\.00<\/cbc:PayableAmount>/);
});

test('odobrenje 381: CreditNote s pozitivnim iznosima', () => {
  const { xml, root, totals } = buildUbl({
    ...base,
    kind: 'CREDIT_NOTE',
    number: '14/PP1/1',
    discountPct: 0,
    discountAmount: 0,
    lines: [{ description: 'Popust na kvalitetu', qty: -1, unitPrice: 40 }],
    billingReference: { number: '12/PP1/1', date: '2026-03-05' },
  });
  assert.equal(root, 'CreditNote');
  assert.equal(tag(xml, 'cbc:CreditNoteTypeCode'), '381');
  assert.equal(tag(xml, 'cbc:ProfileID'), 'P9');
  assert.match(xml, /<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"/);
  assert.match(xml, /<cac:CreditNoteLine>/);
  assert.match(xml, /<cbc:CreditedQuantity unitCode="H87">1\.000<\/cbc:CreditedQuantity>/);
  assert.doesNotMatch(xml, /<cbc:DueDate>/);
  assert.doesNotMatch(xml, /ItemClassificationCode/);
  assert.match(xml, /<cac:BillingReference>/);
  assert.equal(totals.net, 40);
  assert.equal(totals.total, 50);
  assert.match(xml, /<cbc:PayableAmount currencyID="EUR">50\.00<\/cbc:PayableAmount>/);
});

test('predujam 386: plaćeno unaprijed, za platiti 0', () => {
  const { xml, totals } = buildUbl({ ...base, kind: 'ADVANCE', discountPct: 0, discountAmount: 0, lines: [{ description: 'Predujam', qty: 1, unitPrice: 100 }] });
  assert.equal(tag(xml, 'cbc:InvoiceTypeCode'), '386');
  assert.equal(tag(xml, 'cbc:ProfileID'), 'P4');
  assert.equal(totals.prepaid, 125);
  assert.equal(totals.payable, 0);
  assert.doesNotMatch(xml, /<cac:Delivery>/);
});

test('EU kupac: kategorija E s razlogom oslobođenja i HR proširenjem', () => {
  const { xml, totals } = buildUbl({
    ...base,
    buyer: { name: 'Gasthaus Alpenblick GmbH', vatId: 'ATU12345678', address: 'Hauptstraße 1', zip: '6020', city: 'Innsbruck', country: 'AT' },
    vatRate: 0,
    taxCategory: 'K',
    exemptReason: 'Oslobođeno PDV-a — isporuka unutar EU (čl. 41. Zakona o PDV-u)',
    discountPct: 0,
    discountAmount: 0,
  });
  assert.equal(totals.category, 'E');
  assert.equal(totals.vat, 0);
  assert.equal(totals.total, 230);
  assert.match(xml, /<cbc:TaxExemptionReason>Oslobođeno PDV-a — isporuka unutar EU/);
  assert.match(xml, /<cbc:CompanyID>ATU12345678<\/cbc:CompanyID>/);
  assert.match(xml, /HRFISK20Data/);
  assert.match(xml, /<cbc:IdentificationCode>AT<\/cbc:IdentificationCode>/);
});

test('neoporezive naknade ulaze u ukupno, ne u PDV', () => {
  const { xml, totals } = buildUbl({ ...base, discountPct: 0, discountAmount: 0, charges: [{ kind: 'POVNAK', label: 'Povratna naknada', amount: 0.5 }] });
  assert.equal(totals.net, 230);
  assert.equal(totals.vat, 57.5);
  assert.equal(totals.charges, 0.5);
  assert.equal(totals.total, 288);
  assert.match(xml, /<cbc:ChargeIndicator>true<\/cbc:ChargeIndicator>\n    <cbc:AllowanceChargeReason>#HR:POVNAK#Povratna naknada/);
  assert.match(xml, /<cbc:ChargeTotalAmount currencyID="EUR">0\.50<\/cbc:ChargeTotalAmount>/);
  assert.match(xml, /<cbc:TaxExclusiveAmount currencyID="EUR">230\.50<\/cbc:TaxExclusiveAmount>/);
});

test('najam: profil P2 i razdoblje; jedinica mjesec', () => {
  const { xml } = buildUbl({ ...base, type: 'RENT', period: '2026-02', discountPct: 0, discountAmount: 0, lines: [{ description: 'Najam', qty: 1, unit: 'mj', unitPrice: 30 }] });
  assert.equal(tag(xml, 'cbc:ProfileID'), 'P2');
  assert.match(xml, /<cac:InvoicePeriod><cbc:StartDate>2026-02-01<\/cbc:StartDate><cbc:EndDate>2026-02-28<\/cbc:EndDate>/);
  assert.match(xml, /unitCode="MON"/);
});

test('porezni tretman i jedinice', () => {
  assert.deepEqual(ublTreatment({ taxCategory: 'S', vatRate: 13, seller }).hr, 'HR:PDV13');
  const nr = ublTreatment({ taxCategory: 'O', vatRate: 0, seller: { ...seller, vatRegistered: false } });
  assert.equal(nr.category, 'E');
  assert.ok(nr.notRegistered);
  assert.match(nr.reason, /čl\. 90/);
  assert.equal(ublTreatment({ taxCategory: 'O', vatRate: 0, seller }).category, 'O');
  assert.equal(unitCode('kom'), 'H87');
  assert.equal(unitCode('mj'), 'MON');
  assert.equal(unitCode('nepoznato'), 'H87');
});

test('kategorija O: bez stope i bez PDV ID-a stranaka', () => {
  const { xml } = buildUbl({ ...base, taxCategory: 'O', vatRate: 0, discountPct: 0, discountAmount: 0 });
  assert.doesNotMatch(xml, /<cac:PartyTaxScheme>/);
  assert.doesNotMatch(xml, /<cbc:ID>O<\/cbc:ID><cbc:Percent>/);
});
