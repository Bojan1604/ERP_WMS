/**
 * eRačun — UBL 2.1 XML po hrvatskoj specifikaciji CIUS-2025 (s proširenjem ext-2025).
 * Čista funkcija: ulaz su obični podaci dokumenta, izlaz je XML niz i zbrojevi.
 *
 *   račun             → Invoice 380, profil P1 (najam P2, s uračunatim predujmom P11)
 *   račun za predujam → Invoice 386, P4, PrepaidAmount = ukupno, PayableAmount 0
 *   storno            → korektivni Invoice 384, P10, negativne količine i iznosi, BillingReference
 *   knjižno odobrenje → CreditNote 381, P9, pozitivni iznosi, BillingReference
 *
 * Pravila iz specifikacije:
 *   • stranke nose OIB kao elektroničku adresu (schemeID 9934) i PDV ID (HR + OIB)
 *   • svaka stavke računa nosi KPD 2025: ItemClassificationCode listID="CG"
 *   • plaćanje 30 (kreditni transfer) s IBAN-om i pozivom na broj HR00
 *   • popust na dokument je AllowanceCharge (ChargeIndicator false), neoporezive naknade
 *     AllowanceCharge (true) sa zasebnim poreznim podzbrojem
 *   • kategorije izvan S nose razlog oslobođenja; O nema stopu ni PDV ID stranaka
 */
import { CHARGE_KINDS, documentTotals, lineNet, type ChargeInput } from './invoice';
import { r2 } from './money';
import { NOT_REGISTERED_REASON, VAT_ON_PAYMENT_NOTE, VAT_ON_PAYMENT_UBL } from './tax';

export const CIUS_ID = 'urn:cen.eu:en16931:2017#compliant#urn:mfin.gov.hr:cius-2025:1.0#conformant#urn:mfin.gov.hr:ext-2025:1.0';
export const HREXT_NS = 'urn:mfin.gov.hr:schema:xsd:HRExtensionAggregateComponents-1';
export const KPD_LIST_ID = 'CG';
export const EAS_HR = '9934';

export type UblKind = 'INVOICE' | 'ADVANCE' | 'STORNO' | 'CREDIT_NOTE';

export interface UblParty {
  name: string;
  oib?: string | null;
  vatId?: string | null;
  address?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
  /** eRačun adresa „shema:id" (npr. 9934:12345678901 ili 0088:…); prazno = OIB u shemi 9934 (domaći). */
  endpointId?: string | null;
  /** Poslovna jedinica kupca: šifra (HR99) i naziv. */
  branchCode?: string | null;
  branchName?: string | null;
}

/** eRačun adresa „shema:id" → shema (EAS) i id; bez sheme = 9934 (OIB). */
export function parseEndpoint(v: string | null | undefined): { scheme: string; id: string } | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4}):(.+)$/);
  return m ? { scheme: m[1], id: m[2].trim() } : { scheme: EAS_HR, id: s };
}

export interface UblLine {
  description: string;
  serial?: string | null;
  /** Više uređaja u jednoj stavci (količina > 1). */
  serials?: string[] | null;
  code?: string | null;
  kpd?: string | null;
  unit?: string | null;
  qty: number;
  unitPrice: number;
  discountPct?: number | null;
}

export interface UblInput {
  kind: UblKind;
  type?: 'SALE' | 'RENT' | 'SERVICE';
  number: string;
  issueDate: string;
  /** HH:MM:SS po lokalnom vremenu izdavanja. */
  issueTime?: string;
  dueDate?: string | null;
  deliveryDate?: string | null;
  /** Razdoblje najma YYYY-MM (prvi mjesec rate). */
  period?: string | null;
  /** Broj mjeseci koje rata pokriva (kvartalno 3…) — InvoicePeriod od–do; zadano 1. */
  periodMonths?: number | null;
  currency?: string;
  notes?: Array<string | null | undefined>;
  seller: UblParty & { iban?: string | null; vatRegistered?: boolean };
  /** Izdavatelj obračunava PDV po naplaćenoj naknadi (oznaka u HR proširenju i napomena). */
  vatOnPayment?: boolean;
  /** Operater (HR-BT-4/5): ime i OIB osobe koja izdaje račun. */
  operator?: { name: string; oib?: string | null } | null;
  buyer: UblParty;
  vatRate: number;
  taxCategory?: string | null;
  exemptReason?: string | null;
  discountPct?: number;
  discountAmount?: number;
  charges?: ChargeInput[];
  advanceAmount?: number;
  paymentModel?: string;
  paymentReference?: string | null;
  paymentMeansCode?: string;
  /** Storno i odobrenje: izvorni račun (kind = vrsta izvornog). */
  billingReference?: { number: string; date?: string | null; kind?: UblKind } | null;
  /** Konačni račun: uračunati računi za predujam (BillingReference na svaki, profil P11). */
  advanceReferences?: Array<{ number: string; date?: string | null }>;
  lines: UblLine[];
}

export interface UblTotals {
  lines: number;
  discount: number;
  net: number;
  vat: number;
  charges: number;
  total: number;
  prepaid: number;
  payable: number;
  category: string;
  percent: number;
  profile: string;
}

// ---------------------------------------------------------------- šifre

/** Jedinice mjere (UN/ECE Rec 20) koje program koristi. */
const UNITS: Array<{ code: string; aliases: string[] }> = [
  { code: 'H87', aliases: ['kom', 'komad', 'kos', 'pcs', 'ea', 'c62', ''] },
  { code: 'MON', aliases: ['mj', 'mjesec', 'mjeseci', 'mth'] },
  { code: 'HUR', aliases: ['sat', 'sati', 'h', 'hr'] },
  { code: 'DAY', aliases: ['dan', 'dana', 'd'] },
  { code: 'ANN', aliases: ['god', 'godina'] },
  { code: 'KMT', aliases: ['km'] },
  { code: 'KGM', aliases: ['kg'] },
  { code: 'LTR', aliases: ['l', 'lit'] },
  { code: 'MTR', aliases: ['m'] },
  { code: 'SET', aliases: ['set', 'komplet'] },
  { code: 'LS', aliases: ['pausal', 'paušal'] },
];

export function unitCode(unit: string | null | undefined): string {
  const raw = String(unit ?? '').trim();
  const u = raw.toLowerCase();
  const hit = UNITS.find((x) => x.code.toLowerCase() === u || x.aliases.includes(u));
  if (hit) return hit.code;
  if (/^[A-Z0-9]{2,3}$/.test(raw)) return raw;
  return 'H87';
}

const DEFAULT_REASON: Record<string, string> = {
  AE: 'Prijenos porezne obveze — čl. 17. st. 1. Zakona o PDV-u',
  E: 'Oslobođeno PDV-a',
  O: 'Nije predmet oporezivanja PDV-om u RH — mjesto oporezivanja izvan RH',
  Z: '',
};

const CHARGE_HR: Record<ChargeInput['kind'], { hr: string; scheme: string }> = {
  N: { hr: 'HR:N', scheme: 'VAT' },
  POVNAK: { hr: 'HR:POVNAK', scheme: 'OTH' },
  PP: { hr: 'HR:PP', scheme: 'LOC' },
  PPMV: { hr: 'HR:PPMV', scheme: 'CAR' },
};

export interface UblTreatment {
  category: string;
  percent: number;
  hr: string;
  reason: string;
  /** Firma izvan sustava PDV-a — PDV ID ide u shemi FRE. */
  notRegistered: boolean;
}

/**
 * Porezni tretman za XML. Oznake K (isporuka unutar EU) i G (izvoz) idu kao E s
 * razlogom oslobođenja — tako ih posrednik prihvaća; firma izvan sustava PDV-a
 * šalje E s razlogom iz čl. 90.
 */
export function ublTreatment(input: Pick<UblInput, 'taxCategory' | 'exemptReason' | 'vatRate' | 'seller'>): UblTreatment {
  let cat = String(input.taxCategory || 'S').toUpperCase();
  let reason = String(input.exemptReason ?? '').trim();
  const notRegistered = input.seller.vatRegistered === false;
  if (notRegistered) {
    cat = 'E';
    // jedna osnova kao na ispisu (čl. 90. st. 2.) — i za starije račune s drugim stavkom čl. 90.
    if (!reason || /čl\.\s*90\./.test(reason)) reason = NOT_REGISTERED_REASON;
  }
  if (cat === 'K' || cat === 'G') cat = 'E';
  if (!['S', 'AE', 'E', 'Z', 'O'].includes(cat)) cat = 'S';
  const percent = cat === 'S' ? Number(input.vatRate) || 0 : 0;
  if (cat !== 'S') reason ||= DEFAULT_REASON[cat] ?? '';
  return { category: cat, percent, hr: cat === 'S' ? `HR:PDV${fmtPct(percent)}` : `HR:${cat}`, reason: cat === 'S' ? '' : reason, notRegistered };
}

/** Profil poslovnog procesa (BT-23). */
export function ublProfile(input: Pick<UblInput, 'kind' | 'type' | 'advanceAmount'>): string {
  if (input.kind === 'STORNO') return 'P10';
  if (input.kind === 'CREDIT_NOTE') return 'P9';
  if (input.kind === 'ADVANCE') return 'P4';
  if ((input.advanceAmount ?? 0) > 0) return 'P11';
  if (input.type === 'RENT') return 'P2';
  return 'P1';
}

// ---------------------------------------------------------------- oblikovanje

export const xmlEscape = (s: unknown) =>
  String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const esc = xmlEscape;
const amt = (n: number) => r2(n).toFixed(2);
const qty3 = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);
const price6 = (n: number) => (Math.round(n * 1e6) / 1e6).toFixed(6);
function fmtPct(n: number) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
const digits = (s: string | null | undefined) => String(s ?? '').replace(/\s+/g, '');

/** Razdoblje rate: od prvog dana mjeseca `period` do zadnjeg dana mjeseca `months − 1` kasnije. */
function periodBounds(period: string | null | undefined, months = 1) {
  const m = String(period ?? '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const endMonth = Number(m[2]) - 1 + Math.max(1, months);
  const end = new Date(Date.UTC(Number(m[1]), endMonth, 0));
  return { from: `${m[1]}-${m[2]}-01`, to: end.toISOString().slice(0, 10) };
}

function partyXml(p: {
  endpointId?: string | null;
  endpointScheme?: string | null;
  /** PartyIdentification (poslovna jedinica) i PartyName. */
  branchId?: string | null;
  branchName?: string | null;
  name: string;
  street?: string | null;
  zip?: string | null;
  city?: string | null;
  country: string;
  taxId?: string | null;
  taxScheme?: string;
  legalId?: string | null;
}) {
  const ep = p.endpointId ? `\n      <cbc:EndpointID schemeID="${esc(p.endpointScheme || EAS_HR)}">${esc(p.endpointId)}</cbc:EndpointID>` : '';
  const branch = p.branchId
    ? `\n      <cac:PartyIdentification><cbc:ID>${esc(p.branchId)}</cbc:ID></cac:PartyIdentification>${p.branchName ? `\n      <cac:PartyName><cbc:Name>${esc(p.branchName)}</cbc:Name></cac:PartyName>` : ''}`
    : '';
  const tax = p.taxId
    ? `\n      <cac:PartyTaxScheme><cbc:CompanyID>${esc(p.taxId)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>${esc(p.taxScheme ?? 'VAT')}</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`
    : '';
  return `<cac:Party>${ep}${branch}
      <cac:PostalAddress>
        <cbc:StreetName>${esc(p.street)}</cbc:StreetName>
        <cbc:CityName>${esc(p.city)}</cbc:CityName>
        <cbc:PostalZone>${esc(p.zip)}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>${esc(p.country)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>${tax}
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>${p.legalId ? `<cbc:CompanyID>${esc(p.legalId)}</cbc:CompanyID>` : ''}</cac:PartyLegalEntity>
    </cac:Party>`;
}

function taxCategoryXml(t: UblTreatment, tag = 'TaxCategory', withName = false) {
  const percent = t.category === 'O' ? '' : `<cbc:Percent>${fmtPct(t.percent)}</cbc:Percent>`;
  const reason = t.category !== 'S' && t.reason ? `<cbc:TaxExemptionReason>${esc(t.reason)}</cbc:TaxExemptionReason>` : '';
  return `<cac:${tag}><cbc:ID>${t.category}</cbc:ID>${withName ? `<cbc:Name>${esc(t.hr)}</cbc:Name>` : ''}${percent}${reason}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:${tag}>`;
}

// ---------------------------------------------------------------- dokument

export function buildUbl(input: UblInput): { xml: string; root: 'Invoice' | 'CreditNote'; fileName: string; totals: UblTotals } {
  // valuta ide u atribut currencyID — escapira se jednom ovdje (obrana i kad u bazi nije ispravna oznaka)
  const cur = esc(input.currency || 'EUR');
  const credit = input.kind === 'CREDIT_NOTE';
  const storno = input.kind === 'STORNO';
  const advance = input.kind === 'ADVANCE';
  const root = credit ? 'CreditNote' : 'Invoice';
  // odobrenje je u bazi negativno, u XML ide pozitivno; storno ostaje negativan
  const sign = credit ? -1 : 1;
  const t = ublTreatment(input);
  const refAdvance = input.billingReference?.kind === 'ADVANCE';

  const dt = documentTotals({
    lines: input.lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct ?? 0 })),
    vatRate: t.percent,
    discountPct: input.discountPct ?? 0,
    discountAmount: input.discountAmount ?? 0,
    charges: input.charges ?? [],
  });
  const linesTotal = r2(sign * dt.linesNet);
  const discount = r2(sign * dt.discount);
  const net = r2(sign * dt.net);
  const vat = r2(sign * dt.vat);
  const charges = (input.charges ?? [])
    .map((c) => {
      const def = CHARGE_KINDS[c.kind] ?? CHARGE_KINDS.N;
      const abs = def.pct && c.pct ? (Math.abs(dt.net) * c.pct) / 100 : Math.abs(c.amount ?? 0);
      const s = dt.net < 0 ? -1 : 1;
      return { ...c, def, hr: CHARGE_HR[c.kind] ?? CHARGE_HR.N, name: c.label || def.label, amount: r2(sign * s * r2(abs)) };
    })
    .filter((c) => c.amount !== 0);
  const chargesTotal = r2(charges.reduce((a, c) => a + c.amount, 0));
  const total = r2(net + vat + chargesTotal);
  const prepaid = advance || ((credit || storno) && refAdvance) ? total : r2(input.advanceAmount ?? 0);
  const payable = storno ? r2(total - prepaid) : r2(Math.max(0, total - prepaid));
  const profile = ublProfile(input);

  // ---- stavke
  const lineTag = credit ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = credit ? 'CreditedQuantity' : 'InvoicedQuantity';
  const withKpd = !credit && !advance && !refAdvance;
  const linesXml = input.lines
    .map((l, i) => {
      const q = sign * l.qty;
      const lineAmount = r2(sign * lineNet({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct ?? 0 }));
      const gross = Math.abs(l.unitPrice);
      const disc = l.discountPct ? (gross * l.discountPct) / 100 : 0;
      const unit = unitCode(l.unit);
      const sns = l.serials?.length ? l.serials : l.serial ? [l.serial] : [];
      const sellersId = l.code || (sns.length === 1 ? sns[0] : null);
      const klas = withKpd && l.kpd
        ? `\n      <cac:CommodityClassification><cbc:ItemClassificationCode listID="${KPD_LIST_ID}">${esc(l.kpd)}</cbc:ItemClassificationCode></cac:CommodityClassification>`
        : '';
      return `  <cac:${lineTag}>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:${qtyTag} unitCode="${unit}">${qty3(q)}</cbc:${qtyTag}>
    <cbc:LineExtensionAmount currencyID="${cur}">${amt(lineAmount)}</cbc:LineExtensionAmount>
    <cac:Item>${sns.length ? `\n      <cbc:Description>${esc(`SN: ${sns.join(', ')}`)}</cbc:Description>` : ''}
      <cbc:Name>${esc(l.description)}</cbc:Name>${sellersId ? `\n      <cac:SellersItemIdentification><cbc:ID>${esc(sellersId)}</cbc:ID></cac:SellersItemIdentification>` : ''}${klas}
      ${taxCategoryXml(t, 'ClassifiedTaxCategory', true)}
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${cur}">${price6(gross - disc)}</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="${unit}">1.000</cbc:BaseQuantity>${
        disc > 0
          ? `\n      <cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:Amount currencyID="${cur}">${price6(disc)}</cbc:Amount><cbc:BaseAmount currencyID="${cur}">${price6(gross)}</cbc:BaseAmount></cac:AllowanceCharge>`
          : ''
      }
    </cac:Price>
  </cac:${lineTag}>`;
    })
    .join('\n');

  // ---- stranke
  const sellerCountry = (input.seller.country || 'HR').toUpperCase();
  const sellerOib = digits(input.seller.oib);
  const vatOnParties = !t.notRegistered && t.category !== 'O';
  const supplier = partyXml({
    endpointId: sellerOib,
    name: input.seller.name,
    street: input.seller.address,
    zip: input.seller.zip,
    city: input.seller.city,
    country: sellerCountry,
    taxId: t.notRegistered ? sellerOib : t.category === 'O' ? null : input.seller.vatId || (sellerOib ? `HR${sellerOib}` : null),
    taxScheme: t.notRegistered ? 'FRE' : 'VAT',
    legalId: t.notRegistered || t.category === 'O' ? sellerOib : null,
  });
  const op = input.operator;
  const sellerContact = op ? `\n    <cac:SellerContact>${op.oib ? `<cbc:ID>${esc(op.oib)}</cbc:ID>` : ''}<cbc:Name>${esc(op.name)}</cbc:Name></cac:SellerContact>` : '';

  const buyerCountry = (input.buyer.country || 'HR').toUpperCase();
  const buyerOib = digits(input.buyer.oib);
  const buyerDomestic = buyerCountry === 'HR';
  const buyerVat = buyerDomestic ? input.buyer.vatId || (buyerOib ? `HR${buyerOib}` : '') : input.buyer.vatId || buyerOib;
  // eRačun adresa kupca: upisana na partneru, inače OIB (samo domaći); poslovna jedinica 9934:OIB::HR99:šifra
  const buyerEp = parseEndpoint(input.buyer.endpointId) ?? (buyerDomestic && buyerOib ? { scheme: EAS_HR, id: buyerOib } : null);
  const branchCode = String(input.buyer.branchCode ?? '').trim();
  const customer = partyXml({
    endpointId: buyerEp?.id ?? null,
    endpointScheme: buyerEp?.scheme ?? null,
    branchId: branchCode && buyerDomestic && buyerOib ? `${EAS_HR}:${buyerOib}::HR99:${branchCode}` : null,
    branchName: branchCode ? input.buyer.branchName || null : null,
    name: input.buyer.name,
    street: input.buyer.address,
    zip: input.buyer.zip,
    city: input.buyer.city,
    country: buyerCountry,
    taxId: vatOnParties ? buyerVat : null,
    legalId: vatOnParties ? null : buyerOib || input.buyer.vatId,
  });

  // ---- zaglavlje
  const time = input.issueTime || '00:00:00';
  const head = credit
    ? `  <cbc:IssueDate>${esc(input.issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${esc(time)}</cbc:IssueTime>
  <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>`
    : `  <cbc:IssueDate>${esc(input.issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${esc(time)}</cbc:IssueTime>
  <cbc:DueDate>${esc(input.dueDate || input.issueDate)}</cbc:DueDate>
  <cbc:InvoiceTypeCode>${advance ? 386 : storno ? 384 : 380}</cbc:InvoiceTypeCode>`;
  const notes = [...(input.notes ?? []), input.vatOnPayment ? VAT_ON_PAYMENT_NOTE : null].filter((n): n is string => !!n && !!n.trim());
  const period = input.type === 'RENT' && !advance && !storno ? periodBounds(input.period, input.periodMonths ?? 1) : null;
  const refXml = (r: { number: string; date?: string | null }) =>
    `\n  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(r.number)}</cbc:ID>${r.date ? `<cbc:IssueDate>${esc(r.date)}</cbc:IssueDate>` : ''}</cac:InvoiceDocumentReference></cac:BillingReference>`;
  // storno/odobrenje → izvorni račun; konačni račun → svaki uračunati predujam
  const ref =
    input.billingReference && (credit || storno)
      ? refXml(input.billingReference)
      : input.kind === 'INVOICE'
        ? (input.advanceReferences ?? []).map(refXml).join('')
        : '';
  const paymentId = [input.paymentModel || 'HR00', input.paymentReference].filter(Boolean).join(' ');
  const delivery = advance || refAdvance ? '' : `\n  <cac:Delivery><cbc:ActualDeliveryDate>${esc(input.deliveryDate || input.issueDate)}</cbc:ActualDeliveryDate></cac:Delivery>`;

  // ---- popust i naknade na razini dokumenta
  const discountXml =
    discount !== 0
      ? `\n  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>Popust</cbc:AllowanceChargeReason>${
      input.discountPct && !input.discountAmount ? `\n    <cbc:MultiplierFactorNumeric>${fmtPct(input.discountPct)}</cbc:MultiplierFactorNumeric>` : ''
    }
    <cbc:Amount currencyID="${cur}">${amt(discount)}</cbc:Amount>
    <cbc:BaseAmount currencyID="${cur}">${amt(linesTotal)}</cbc:BaseAmount>
    ${taxCategoryXml(t, 'TaxCategory', true)}
  </cac:AllowanceCharge>`
      : '';
  const chargesXml = charges
    .map(
      (c) => `\n  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>true</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>#${c.hr.hr}#${esc(c.name)}</cbc:AllowanceChargeReason>${c.def.pct && c.pct ? `\n    <cbc:MultiplierFactorNumeric>${fmtPct(c.pct)}</cbc:MultiplierFactorNumeric>` : ''}
    <cbc:Amount currencyID="${cur}">${amt(c.amount)}</cbc:Amount>${c.def.pct && c.pct ? `\n    <cbc:BaseAmount currencyID="${cur}">${amt(net)}</cbc:BaseAmount>` : ''}
    <cac:TaxCategory><cbc:ID>E</cbc:ID><cbc:Name>${c.hr.hr}</cbc:Name><cbc:Percent>0.00</cbc:Percent><cbc:TaxExemptionReason>${esc(c.name)}</cbc:TaxExemptionReason><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
  </cac:AllowanceCharge>`,
    )
    .join('');

  // ---- porezna rekapitulacija
  const subtotals =
    `\n    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${amt(net)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">${amt(vat)}</cbc:TaxAmount>
      ${taxCategoryXml(t)}
    </cac:TaxSubtotal>` +
    charges
      .map(
        (c) => `\n    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${amt(c.amount)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">0.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>E</cbc:ID><cbc:Percent>0.00</cbc:Percent><cbc:TaxExemptionReason>#${c.hr.hr}#${esc(c.name)}</cbc:TaxExemptionReason><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>`,
      )
      .join('');

  // ---- hrvatski porezni prikaz kad postoji išta izvan običnog PDV-a
  const needHr = t.category !== 'S' || charges.length > 0 || t.notRegistered || !!input.vatOnPayment;
  const hrExt = needHr
    ? `
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <hrextac:HRFISK20Data>${input.vatOnPayment ? `\n          <hrextac:HRObracunPDVPoNaplati>${VAT_ON_PAYMENT_UBL}</hrextac:HRObracunPDVPoNaplati>` : ''}
          <hrextac:HRTaxTotal>
            <cbc:TaxAmount currencyID="${cur}">${amt(vat)}</cbc:TaxAmount>
            <hrextac:HRTaxSubtotal>
              <cbc:TaxableAmount currencyID="${cur}">${amt(net)}</cbc:TaxableAmount>
              <cbc:TaxAmount currencyID="${cur}">${amt(vat)}</cbc:TaxAmount>
              <hrextac:HRTaxCategory><cbc:ID>${t.category}</cbc:ID><cbc:Name>${esc(t.hr)}</cbc:Name><cbc:Percent>${fmtPct(t.percent)}</cbc:Percent>${t.reason ? `<cbc:TaxExemptionReason>${esc(t.reason)}</cbc:TaxExemptionReason>` : ''}<hrextac:HRTaxScheme><cbc:ID>VAT</cbc:ID></hrextac:HRTaxScheme></hrextac:HRTaxCategory>
            </hrextac:HRTaxSubtotal>${charges
              .map(
                (c) => `
            <hrextac:HRTaxSubtotal>
              <cbc:TaxableAmount currencyID="${cur}">${amt(c.amount)}</cbc:TaxableAmount>
              <cbc:TaxAmount currencyID="${cur}">0.00</cbc:TaxAmount>
              <hrextac:HRTaxCategory><cbc:ID>O</cbc:ID><cbc:Name>${c.hr.hr}</cbc:Name><cbc:Percent>0</cbc:Percent><hrextac:HRTaxScheme><cbc:ID>${c.hr.scheme}</cbc:ID></hrextac:HRTaxScheme></hrextac:HRTaxCategory>
            </hrextac:HRTaxSubtotal>`,
              )
              .join('')}
          </hrextac:HRTaxTotal>
          <hrextac:HRLegalMonetaryTotal>
            <cbc:TaxExclusiveAmount currencyID="${cur}">${amt(net)}</cbc:TaxExclusiveAmount>
            <hrextac:OutOfScopeOfVATAmount currencyID="${cur}">${amt(chargesTotal)}</hrextac:OutOfScopeOfVATAmount>
          </hrextac:HRLegalMonetaryTotal>
        </hrextac:HRFISK20Data>
      </ext:ExtensionContent>
    </ext:UBLExtension>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
         xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2"
         xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2"${needHr ? `\n         xmlns:hrextac="${HREXT_NS}"` : ''}>
  <ext:UBLExtensions>${hrExt}
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <sig:UBLDocumentSignatures>
          <sac:SignatureInformation></sac:SignatureInformation>
        </sig:UBLDocumentSignatures>
      </ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:CustomizationID>${CIUS_ID}</cbc:CustomizationID>
  <cbc:ProfileID>${profile}</cbc:ProfileID>
  <cbc:ID>${esc(input.number)}</cbc:ID>
${head}${notes.map((n) => `\n  <cbc:Note>${esc(n)}</cbc:Note>`).join('')}
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>${
    period ? `\n  <cac:InvoicePeriod><cbc:StartDate>${period.from}</cbc:StartDate><cbc:EndDate>${period.to}</cbc:EndDate></cac:InvoicePeriod>` : ''
  }${ref}
  <cac:AccountingSupplierParty>
    ${supplier}${sellerContact}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    ${customer}
  </cac:AccountingCustomerParty>${delivery}
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>${esc(input.paymentMeansCode || '30')}</cbc:PaymentMeansCode>
    <cbc:PaymentID>${esc(paymentId)}</cbc:PaymentID>
    <cac:PayeeFinancialAccount><cbc:ID>${esc(digits(input.seller.iban))}</cbc:ID></cac:PayeeFinancialAccount>
  </cac:PaymentMeans>${discountXml}${chargesXml}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${cur}">${amt(vat)}</cbc:TaxAmount>${subtotals}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${cur}">${amt(linesTotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${cur}">${amt(net + chargesTotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${cur}">${amt(total)}</cbc:TaxInclusiveAmount>${
      discount !== 0 ? `\n    <cbc:AllowanceTotalAmount currencyID="${cur}">${amt(discount)}</cbc:AllowanceTotalAmount>` : ''
    }${chargesTotal !== 0 ? `\n    <cbc:ChargeTotalAmount currencyID="${cur}">${amt(chargesTotal)}</cbc:ChargeTotalAmount>` : ''}${
      prepaid !== 0 ? `\n    <cbc:PrepaidAmount currencyID="${cur}">${amt(prepaid)}</cbc:PrepaidAmount>` : ''
    }
    <cbc:PayableAmount currencyID="${cur}">${amt(payable)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${linesXml}
</${root}>
`;

  return {
    xml,
    root,
    fileName: `eRacun-${String(input.number || 'nacrt').replace(/[^\w-]+/g, '-')}.xml`,
    totals: {
      lines: linesTotal,
      discount,
      net,
      vat,
      charges: chargesTotal,
      total,
      prepaid,
      payable,
      category: t.category,
      percent: t.percent,
      profile,
    },
  };
}
