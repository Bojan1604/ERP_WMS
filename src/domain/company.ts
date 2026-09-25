/**
 * Postavke firme — pravila koja vrijede i za obrazac (services/settings.ts) i
 * za postavke preuzete iz uvezene datoteke (sigurnosna kopija, stara verzija).
 */

import { DEFAULT_BRAND_COLOR, DEFAULT_MENU_COLOR, normalizeHex, storedColor } from './brand-colors';

/** Najveći logo (bajtovi slike). */
export const MAX_LOGO_BYTES = 300 * 1024;

const LOGO_RE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/;

/** Logo je slika u data URL-u (PNG, JPG, GIF, WebP, SVG) i nije veći od 300 KB. */
export const isValidLogo = (v: string) => LOGO_RE.test(v) && v.length * 0.75 <= MAX_LOGO_BYTES * 1.02;

/** Oznaka valute ISO 4217 (tri velika slova). */
export const isCurrencyCode = (v: string) => /^[A-Z]{3}$/.test(v);

/** Brojčane postavke: [najmanje, najviše, cijeli broj] — iste granice kao u obrascu postavki. */
export const COMPANY_NUMBER_LIMITS = {
  vatRate: [0, 100, false],
  overdueDays: [0, 3650, true],
  paymentTermDays: [0, 365, true],
  quoteValidDays: [0, 365, true],
  defaultMarginPct: [0, 99.99, false],
  defaultWarrantyMonths: [0, 240, true],
  rentFallbackPct: [0, 100, false],
  backupKeep: [1, 365, true],
  backupReminderDays: [0, 365, true],
} as const satisfies Record<string, readonly [number, number, boolean]>;

const TEXT_FIELDS = ['name', 'oib', 'vatId', 'address', 'zip', 'city', 'iban', 'bank', 'email', 'phone', 'web', 'invoiceFooter'] as const;
/** Postavke dokumenata, poreza i eRačuna (F9) — tekst do 1000 znakova. */
const DOC_TEXT_FIELDS = [
  'swift', 'proformaTitle', 'operatorName', 'operatorOib', 'vatTextEuGoods', 'vatTextEuService', 'vatTextThirdGoods', 'vatTextThirdService',
  'legalFooter', 'kpdRent', 'kpdSale', 'kpdService', 'accountantEmail',
] as const;
const BOOL_FIELDS = ['vatRegistered', 'statusChangeNeedsApproval', 'vatOnPayment', 'eInvoiceAttachPdf', 'eReportingEnabled', 'autoBackup'] as const;

export interface CompanySettingsInput {
  name?: string; oib?: string | null; vatId?: string | null; address?: string | null; zip?: string | null; city?: string | null;
  country?: string; iban?: string | null; bank?: string | null; email?: string | null; phone?: string | null; web?: string | null;
  logo?: string | null; currency?: string; vatRegistered?: boolean; vatRate?: number; overdueDays?: number; paymentTermDays?: number;
  quoteValidDays?: number; defaultMarginPct?: number; defaultWarrantyMonths?: number; rentFallbackPct?: number;
  invoicePremises?: string; invoiceDevice?: string; invoiceSeparator?: string; invoiceFooter?: string | null;
  statusChangeNeedsApproval?: boolean;
  swift?: string | null; proformaTitle?: string | null; operatorName?: string | null; operatorOib?: string | null;
  vatTextEuGoods?: string | null; vatTextEuService?: string | null; vatTextThirdGoods?: string | null; vatTextThirdService?: string | null;
  legalFooter?: string | null; kpdRent?: string | null; kpdSale?: string | null; kpdService?: string | null; accountantEmail?: string | null;
  vatOnPayment?: boolean; eInvoiceAttachPdf?: boolean; eReportingEnabled?: boolean; autoBackup?: boolean;
  backupKeep?: number; backupReminderDays?: number; paymentModel?: string; eInvoicePaymentMeans?: string;
  brandColor?: string | null; menuColor?: string | null;
}

/**
 * Postavke iz datoteke (vanjski ulaz, bilo kojeg tipa) → sigurne vrijednosti:
 * valuta ISO (inače EUR), država ISO-2 (inače HR), logo samo ispravna slika,
 * brojevi unutar granica obrasca, oznake računa bez razmaka, tekst kao tekst.
 * Neispravno se izostavlja (ostaje zadana vrijednost) i vraća u `notes`.
 */
export function sanitizeCompanySettings(raw: Record<string, unknown>): { company: CompanySettingsInput; notes: string[] } {
  const out: CompanySettingsInput = {};
  const notes: string[] = [];
  for (const k of TEXT_FIELDS) {
    const v = raw[k];
    if (typeof v === 'string') (out as Record<string, unknown>)[k] = v.slice(0, k === 'invoiceFooter' ? 2000 : 300);
    else if (v === null && k !== 'name') (out as Record<string, unknown>)[k] = null;
  }
  if (raw.currency !== undefined && raw.currency !== null) {
    const cur = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
    if (isCurrencyCode(cur)) out.currency = cur;
    else {
      out.currency = 'EUR';
      notes.push(`Neispravna valuta „${String(raw.currency).slice(0, 20)}" — postavljeno EUR.`);
    }
  }
  if (typeof raw.country === 'string') {
    const c = raw.country.trim().toUpperCase();
    out.country = /^[A-Z]{2}$/.test(c) ? c : 'HR';
  }
  if (typeof raw.logo === 'string' && raw.logo) {
    if (isValidLogo(raw.logo)) out.logo = raw.logo;
    else notes.push('Logo nije preuzet (mora biti slika PNG, JPG, GIF, WebP ili SVG do 300 KB).');
  }
  for (const [k, [min, max, int]] of Object.entries(COMPANY_NUMBER_LIMITS)) {
    const v = raw[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (!Number.isFinite(n)) continue;
    const clamped = Math.min(max, Math.max(min, int ? Math.round(n) : Math.round(n * 100) / 100));
    if (clamped !== n) notes.push(`Postavka ${k} (${n}) svedena na ${clamped}.`);
    (out as Record<string, unknown>)[k] = clamped;
  }
  for (const k of BOOL_FIELDS) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  for (const k of DOC_TEXT_FIELDS) {
    const v = raw[k];
    if (typeof v === 'string') (out as Record<string, unknown>)[k] = v.slice(0, 1000);
    else if (v === null && k !== 'proformaTitle') (out as Record<string, unknown>)[k] = null;
  }
  // boje firme (#rrggbb); zadana boja = null
  for (const [k, fallback] of [['brandColor', DEFAULT_BRAND_COLOR], ['menuColor', DEFAULT_MENU_COLOR]] as const) {
    const v = raw[k];
    if (v === null) out[k] = null;
    else if (v !== undefined) {
      if (normalizeHex(v)) out[k] = storedColor(v, fallback);
      else notes.push(`Boja firme ${k} „${String(v).slice(0, 20)}" nije ispravna — ostaje zadana.`);
    }
  }
  if (typeof raw.paymentModel === 'string' && isPaymentModel(raw.paymentModel)) out.paymentModel = raw.paymentModel;
  if (raw.eInvoicePaymentMeans === '30' || raw.eInvoicePaymentMeans === '58') out.eInvoicePaymentMeans = raw.eInvoicePaymentMeans;
  for (const [k, maxLen] of [['invoicePremises', 20], ['invoiceDevice', 20], ['invoiceSeparator', 3]] as const) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim() && v.length <= maxLen && !/\s/.test(v)) out[k] = v;
    else if (v !== undefined && v !== null) notes.push(`Neispravna oznaka ${k} „${String(v).slice(0, 20)}" — ostaje zadana.`);
  }
  return { company: out, notes };
}

// ---------------------------------------------------------------- brojači dokumenata (F9)

/**
 * „Sljedeći broj" dokumenta u seriji (nastavak numeracije iz starog programa):
 * brojač se postavlja na `next − 1` i smije samo rasti — ne ispod zadnjeg
 * brojača ni ispod najvećeg već izdanog broja (inače bi se broj ponovio).
 */
export function checkCounterStart(next: number, current: number, maxIssued: number): string | null {
  if (!Number.isInteger(next) || next < 1) return 'Sljedeći broj mora biti cijeli broj veći od 0.';
  if (next > 9_999_999) return 'Sljedeći broj je prevelik.';
  const floor = Math.max(current, maxIssued);
  if (next - 1 < floor) return `Sljedeći broj ne može biti manji od ${floor + 1} — broj ${floor} je već izdan.`;
  return null;
}

/** Model poziva na broj (HR00, HR01 … HR99). */
export const isPaymentModel = (v: string) => /^HR\d{2}$/.test(v);
