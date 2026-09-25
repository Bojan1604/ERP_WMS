/**
 * Prodaja: vrsta stavke (prodaja/najam na istom računu), zadane KPD šifre,
 * stanje eRačuna za popise i poziv na broj predračuna. Čista logika, bez baze.
 */
import { BILLING_MONTHS, type BillingCode, type PlanPeriodInput } from './billing';

export type LineTypeCode = 'SALE' | 'RENT' | 'SERVICE';

/**
 * Vrsta stavke na računu: vlastita (miješani račun) ili vrsta računa. Stavke
 * računa za uslugu (SERVICE) ne diraju uređaje i nemaju nabavnu vrijednost.
 */
export function effectiveLineType(lineType: LineTypeCode | null | undefined, invoiceType: LineTypeCode): LineTypeCode {
  return lineType ?? invoiceType;
}

/** Ima li račun stavke najma (vrsta računa RENT ili barem jedna stavka najma). */
export const hasRentLines = (invoiceType: LineTypeCode, lines: Array<{ lineType?: LineTypeCode | null }>) =>
  invoiceType === 'RENT' || lines.some((l) => l.lineType === 'RENT');

/** Učestalost naplate iz broja mjeseci stavke najma (1 → mjesečno, 3 → kvartalno…). */
/**
 * Plan naplate uređaja koji račun za najam (Prodaja) dodaje na ugovor: naplata kreće
 * od datuma računa (ne ranije od početka ugovora) s učestalošću sa stavke; uvjeti
 * ugovora vrijede kad se poklapaju (prazan plan). Uz „Zatim naplata prelazi u"
 * slijedi drugo razdoblje od zadanog datuma s drugom učestalošću (orig. InvoiceModal).
 */
export function invoiceRentPlan(o: {
  invoiceDate: string;
  contractStart: string;
  contractBilling: BillingCode;
  lineBilling: BillingCode;
  next?: { billing: BillingCode; from: string } | null;
}): PlanPeriodInput[] {
  const from = o.invoiceDate > o.contractStart ? o.invoiceDate : o.contractStart;
  const next = o.next && o.next.from > from ? o.next : null;
  if (next) return [{ from, billing: o.lineBilling }, { from: next.from, billing: next.billing }];
  return from !== o.contractStart || o.lineBilling !== o.contractBilling ? [{ from, billing: o.lineBilling }] : [];
}

export function billingFromMonths(months: number | null | undefined): BillingCode {
  switch (months) {
    case 3:
      return 'QUARTERLY';
    case 6:
      return 'SEMIANNUAL';
    case 12:
      return 'ANNUAL';
    default:
      return 'MONTHLY';
  }
}

/** Broj mjeseci koje naplata pokriva (jednokratno se broji kao 1 mjesec). */
export const monthsOfBilling = (b: BillingCode) => Math.max(1, BILLING_MONTHS[b] ?? 1);

// ---------------------------------------------------------------- KPD 2025

/** KPD 2025 šifra je oblika NN.NN.NN (potkategorija, 6 znamenki). */
export const kpdValid = (code: string | null | undefined) => /^\d\d\.\d\d\.\d\d$/.test(String(code ?? '').trim());

/**
 * KPD stavke kad ga korisnik nije upisao: usluga (i ručna stavka računa za uslugu) → šifra usluge; uređaj/model →
 * šifra modela (za najam `kpdRent` modela); inače zadana šifra firme po vrsti.
 */
export function defaultKpd(a: {
  lineType: LineTypeCode;
  kind: 'DEVICE' | 'MODEL' | 'SERVICE' | 'MANUAL';
  serviceKpd?: string | null;
  modelKpd?: string | null;
  modelKpdRent?: string | null;
  company: { kpdSale?: string | null; kpdRent?: string | null; kpdService?: string | null };
}): string | null {
  const pick = (...v: Array<string | null | undefined>) => v.find((x) => x && x.trim())?.trim() ?? null;
  if (a.kind === 'SERVICE') return pick(a.serviceKpd, a.company.kpdService);
  // račun za uslugu: ručne stavke su usluge
  if (a.lineType === 'SERVICE' && a.kind === 'MANUAL') return pick(a.company.kpdService);
  if (a.lineType === 'RENT') return pick(a.modelKpdRent, a.company.kpdRent, a.kind === 'MANUAL' ? null : a.modelKpd);
  if (a.kind === 'MANUAL') return pick(a.company.kpdSale);
  return pick(a.modelKpd, a.company.kpdSale);
}

// ---------------------------------------------------------------- eRačun — stanje

export const EINVOICE_STATUSES = ['SENT', 'DELIVERED', 'ACCEPTED', 'REJECTED', 'PAID', 'FISCALIZED', 'REPORTED', 'ERROR'] as const;
export type EInvoiceStatusCode = (typeof EINVOICE_STATUSES)[number];

export const EINVOICE_STATUS_LABEL: Record<EInvoiceStatusCode, string> = {
  SENT: 'Poslan',
  DELIVERED: 'Dostavljen',
  ACCEPTED: 'Prihvaćen',
  REJECTED: 'Odbijen',
  PAID: 'Plaćen',
  FISCALIZED: 'Fiskaliziran bez slanja (IR)',
  REPORTED: 'eIzvještavanje (I)',
  ERROR: 'Greška pri slanju',
};

export const EINVOICE_STATUS_TONE: Record<EInvoiceStatusCode, 'neutral' | 'brand' | 'ok' | 'warn' | 'bad' | 'info'> = {
  SENT: 'info',
  DELIVERED: 'brand',
  ACCEPTED: 'ok',
  REJECTED: 'bad',
  PAID: 'ok',
  FISCALIZED: 'info',
  REPORTED: 'info',
  ERROR: 'bad',
};

/** Filtar popisa računa po stanju eRačuna (vrijednosti u URL-u ?eracun=a,b). */
export const EINVOICE_FILTER = ['none', 'SENT', 'DELIVERED', 'REJECTED', 'PAID', 'FISCALIZED', 'REPORTED', 'ERROR'] as const;
export type EInvoiceFilter = (typeof EINVOICE_FILTER)[number];
export const EINVOICE_FILTER_LABEL: Record<EInvoiceFilter, string> = {
  none: 'Nije poslan',
  SENT: 'Poslan',
  DELIVERED: 'Dostavljen / prihvaćen',
  REJECTED: 'Odbijen',
  PAID: 'Plaćen',
  FISCALIZED: 'Fiskaliziran bez slanja (IR)',
  REPORTED: 'eIzvještavanje (I)',
  ERROR: 'Greška pri slanju',
};

/** Filtar → vrijednosti stupca `Invoice.eInvoiceStatus` (null = nije poslan). */
export function einvoiceFilterValues(f: EInvoiceFilter[]): { values: string[]; none: boolean } {
  const values = new Set<string>();
  for (const v of f) {
    if (v === 'DELIVERED') values.add('DELIVERED').add('ACCEPTED');
    else if (v !== 'none') values.add(v);
  }
  return { values: [...values], none: f.includes('none') };
}

const BUSINESS_TEXT: Record<number, string> = { 1: 'poslan', 2: 'dostavljen', 3: 'preuzet', 4: 'zaprimljen', 5: 'prihvaćen', 6: 'odbijen', 7: 'djelomično plaćen', 8: 'plaćen' };

/**
 * Odgovor posrednika na upit o stanju (transportni, poslovni i fiskalizacijski
 * status u raznim oblicima) → jedan redak teksta i stanje za popis.
 */
export function providerStatus(data: unknown): { code: EInvoiceStatusCode; text: string } {
  const parts: string[] = [];
  let business: number | null = null;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    for (const k of ['transportStatus', 'businessStatus', 'fiscalizationStatus', 'status', 'state']) {
      const v = d[k];
      if (v == null || v === '') continue;
      const s =
        typeof v === 'object'
          ? String((v as Record<string, unknown>).status ?? (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).code ?? JSON.stringify(v))
          : String(v);
      if (k === 'businessStatus' && /^\d+$/.test(s)) {
        business = Number(s);
        parts.push(BUSINESS_TEXT[business] ?? s);
      } else parts.push(s);
    }
  } else if (data != null) parts.push(String(data));
  const text = parts.join(' · ') || '—';
  const t = text.toLowerCase();
  let code: EInvoiceStatusCode = 'SENT';
  if (business === 6 || /odbij|reject/.test(t)) code = 'REJECTED';
  else if (business === 8 || (/plać|placen|paid/.test(t) && !/djelomi|partial/.test(t))) code = 'PAID';
  else if (business === 5 || business === 7 || /prihva|accept/.test(t)) code = 'ACCEPTED';
  else if (business === 2 || business === 3 || business === 4 || /dostav|deliver|preuz|zaprim|receiv/.test(t)) code = 'DELIVERED';
  return { code, text };
}

// ---------------------------------------------------------------- predračun

/** Poziv na broj predračuna: redni broj-godina iz broja „PRED-2026-0007" → „7-2026". */
export function proformaReference(number: string): string {
  const m = /(\d{4})-0*(\d+)$/.exec(number);
  return m ? `${m[2]}-${m[1]}` : number.replace(/[^\dA-Za-z-]/g, '');
}
