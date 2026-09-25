/**
 * Prodaja: vrsta stavke (prodaja/najam na istom računu), zadane KPD šifre,
 * stanje eRačuna za popise i poziv na broj predračuna. Čista logika, bez baze.
 */
import { BILLING_MONTHS, type BillingCode, type PlanPeriodInput } from './billing';
import { addMonths, periodEnd, periodOf, periodStart } from './dates';

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

// ---------------------------------------------------------------- razdoblje najma na računu

/** Broj mjeseci koje rata pokriva: najveći broj mjeseci naplate na stavkama najma (bez njih 1). */
export const invoiceRentMonths = (lines: Array<{ months?: number | null }>) => Math.max(1, ...lines.map((l) => l.months ?? 1));

/**
 * Razdoblje koje rata najma pokriva: od prvog dana mjeseca `period` kroz `months`
 * mjeseci (kvartalna rata za 2026-09 → 1. 9. – 30. 11. 2026., oznaka „09/2026 – 11/2026").
 */
export function rentPeriodRange(period: string | null | undefined, months = 1): { from: string; to: string; label: string } | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period ?? ''))) return null;
  const p = period!;
  const last = periodOf(addMonths(periodStart(p), Math.max(1, months) - 1));
  const mm = (x: string) => `${x.slice(5, 7)}/${x.slice(0, 4)}`;
  return { from: periodStart(p), to: periodEnd(last), label: last === p ? mm(p) : `${mm(p)} – ${mm(last)}` };
}

/**
 * Stavka najma na ispisu i u eRačunu: količina je broj uređaja, pa je jedinica „kom"
 * (ne „mj" — to bi značilo broj mjeseci); opis nosi razdoblje, a napomena mjesečni iznos.
 */
export function rentLineView(
  l: { description: string; unit: string; monthly?: number | null; months?: number | null },
  range: { label: string } | null,
): { description: string; unit: string; note: string | null } {
  if (l.monthly == null || !l.months) return { description: l.description, unit: l.unit, note: null };
  const unit = /^(mj|mjesec|mjeseci|mth|mon)$/i.test(l.unit.trim()) ? 'kom' : l.unit;
  const description = range && !l.description.includes(range.label) ? `${l.description} — ${range.label}` : l.description;
  const note = `${l.months} mj × ${l.monthly.toLocaleString('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €/mj po uređaju`;
  return { description, unit, note };
}

// ---------------------------------------------------------------- KPD 2025

/** KPD 2025 šifra je oblika NN.NN.NN (potkategorija, 6 znamenki). */
export const kpdValid = (code: string | null | undefined) => /^\d\d\.\d\d\.\d\d$/.test(String(code ?? '').trim());

/**
 * Traži li dokument KPD na stavkama (HR-BR-25): račun i storno računa da; račun za
 * predujam, knjižno odobrenje i storno predujma idu bez KPD-a (kao službeni primjeri CIUS-2025).
 */
export const kpdRequired = (kind: 'INVOICE' | 'ADVANCE' | 'STORNO' | 'CREDIT_NOTE', refKind?: string | null) =>
  kind === 'INVOICE' || (kind === 'STORNO' && refKind !== 'ADVANCE');

/** Nedostaci KPD-a po stavkama (prazno = u redu): nedostaje šifra ili nije oblika NN.NN.NN. */
export function kpdIssues(lines: Array<{ description: string; kpd?: string | null }>): string[] {
  const out: string[] = [];
  lines.forEach((l, i) => {
    const kpd = String(l.kpd ?? '').trim();
    const name = l.description?.trim() || 'bez opisa';
    if (!kpd) out.push(`Stavka ${i + 1} (${name}) nema KPD 2025 šifru.`);
    else if (!kpdValid(kpd)) out.push(`Stavka ${i + 1} (${name}): KPD „${kpd}" nije oblika NN.NN.NN.`);
  });
  return out;
}

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
  // najam je usluga — KPD robe s modela (prodaja) nije ispravna šifra za najam; bez šifre najma korisnik je upisuje
  if (a.lineType === 'RENT') return pick(a.modelKpdRent, a.company.kpdRent);
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
