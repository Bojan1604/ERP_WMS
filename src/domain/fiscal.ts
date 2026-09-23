/**
 * Fiskalizacija — čista pravila (bez baze i kriptografije).
 *
 * - Fiskalizacija 1.0 (CIS Porezne uprave): računi krajnjim kupcima i svi računi
 *   plaćeni gotovinom, karticom ili „ostalim" načinom → ZKI na računu, JIR od CIS-a.
 * - Fiskalizacija 2.0 (od 2026.): transakcijski računi domaćim poslovnim subjektima
 *   idu kao eRačun (UBL) preko informacijskog posrednika, koji ih prijavljuje Poreznoj.
 */
import { isValidOib } from './tax';
import { TIME_ZONE } from './dates';

export type PaymentMethodCode = 'TRANSFER' | 'CASH' | 'CARD' | 'OTHER';
export type FiscalStatusCode = 'NOT_REQUIRED' | 'PENDING' | 'SENT' | 'FAILED';
export type FiscalRoute = 'CIS' | 'EINVOICE' | 'NONE';
export type EInvoiceProviderCode = 'none' | 'demo' | 'eposlovanje' | 'moj-eracun';

export const PAYMENT_METHODS: PaymentMethodCode[] = ['TRANSFER', 'CASH', 'CARD', 'OTHER'];

export const PAYMENT_METHOD_LABEL: Record<PaymentMethodCode, string> = {
  TRANSFER: 'Transakcijski račun',
  CASH: 'Gotovina',
  CARD: 'Kartica',
  OTHER: 'Ostalo',
};

/** NacinPlac u CIS poruci. */
export const CIS_PAYMENT_CODE: Record<PaymentMethodCode, 'G' | 'K' | 'T' | 'O'> = { CASH: 'G', CARD: 'K', TRANSFER: 'T', OTHER: 'O' };

/** UNCL4461 šifra načina plaćanja za eRačun (BT-81). */
export const UBL_PAYMENT_MEANS: Record<PaymentMethodCode, string> = { TRANSFER: '30', CASH: '10', CARD: '48', OTHER: 'ZZZ' };

export const FISCAL_STATUS_LABEL: Record<FiscalStatusCode, string> = {
  NOT_REQUIRED: 'Nije potrebna',
  PENDING: 'Čeka slanje',
  SENT: 'Fiskalizirano',
  FAILED: 'Greška',
};

export const FISCAL_STATUS_TONE: Record<FiscalStatusCode, 'neutral' | 'warn' | 'ok' | 'bad'> = {
  NOT_REQUIRED: 'neutral',
  PENDING: 'warn',
  SENT: 'ok',
  FAILED: 'bad',
};

export const FISCAL_ROUTE_LABEL: Record<FiscalRoute, string> = {
  CIS: 'Fiskalizacija (CIS)',
  EINVOICE: 'eRačun preko posrednika',
  NONE: 'Bez fiskalizacije',
};

export const EINVOICE_PROVIDERS: Array<{ value: EInvoiceProviderCode; label: string }> = [
  { value: 'none', label: 'Nije odabran' },
  { value: 'demo', label: 'Demo (simulacija, bez slanja)' },
  { value: 'eposlovanje', label: 'ePoslovanje.hr' },
  { value: 'moj-eracun', label: 'Moj-eRačun (još nije podržan)' },
];

export const FISCAL_ENVS = [
  { value: 'TEST', label: 'Test (cistest.apis-it.hr / testno okruženje posrednika)' },
  { value: 'PROD', label: 'Produkcija' },
];

export const CIS_URL = {
  TEST: 'https://cistest.apis-it.hr:8449/FiskalizacijaServiceTest',
  PROD: 'https://cis.porezna-uprava.hr:8449/FiskalizacijaService',
} as const;

// ---------------------------------------------------------------- pravilo: što račun treba

export interface RouteInput {
  paymentMethod: PaymentMethodCode;
  company: { fiscalEnabled: boolean; eInvoiceProvider: string; country?: string | null };
  partner: { country?: string | null; oib?: string | null };
}

/**
 * Domaći poslovni subjekt: hrvatski partner s upisanim OIB-om (11 znamenki; model ne
 * razlikuje fizičke osobe). Kontrolna znamenka se ne traži — pogrešan OIB odbit će posrednik.
 */
export const isDomesticBusiness = (p: RouteInput['partner']) => (p.country ?? 'HR').toUpperCase() === 'HR' && /^\d{11}$/.test(String(p.oib ?? '').trim());

/**
 * Kojim putem račun ide:
 * - gotovina / kartica / ostalo → CIS (kad je fiskalizacija uključena);
 * - transakcijski račun domaćem poslovnom subjektu → eRačun (kad je odabran posrednik);
 * - transakcijski račun krajnjem kupcu u RH → CIS (F2.0: svi B2C računi, bez obzira na način plaćanja);
 * - transakcijski račun stranom kupcu → ništa (XML se može preuzeti ručno).
 */
export function fiscalRoute(i: RouteInput): FiscalRoute {
  const { paymentMethod, company, partner } = i;
  if (paymentMethod !== 'TRANSFER') return company.fiscalEnabled ? 'CIS' : 'NONE';
  if (isDomesticBusiness(partner)) return company.eInvoiceProvider && company.eInvoiceProvider !== 'none' ? 'EINVOICE' : 'NONE';
  if ((partner.country ?? 'HR').toUpperCase() === 'HR' && company.fiscalEnabled) return 'CIS';
  return 'NONE';
}

// ---------------------------------------------------------------- oblikovanje

const pad = (n: number) => String(n).padStart(2, '0');

/** Dijelovi lokalnog vremena (Europe/Zagreb) — CIS očekuje lokalno vrijeme izdavanja. */
export function localParts(d: Date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(f.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/** „dd.MM.yyyy HH:mm:ss" — oblik datuma u ulazu za ZKI. */
export function zkiDateTime(d: Date): string {
  const p = localParts(d);
  return `${pad(p.d)}.${pad(p.mo)}.${p.y} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** „dd.MM.yyyyTHH:mm:ss" — oblik datuma u XML poruci (DatVrijeme, DatumVrijeme). */
export function cisDateTime(d: Date): string {
  return zkiDateTime(d).replace(' ', 'T');
}

/** Iznos s točkom i dvije decimale („123.45", „-10.00"). */
export function cisAmount(n: number): string {
  const v = Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
  return (Object.is(v, -0) ? 0 : v).toFixed(2);
}

export interface ZkiParts {
  oib: string;
  issuedAt: Date;
  seq: number;
  premises: string;
  device: string;
  total: number;
}

/** Niz koji se potpisuje za ZKI: OIB + datum/vrijeme + redni broj + prostor + uređaj + iznos. */
export function zkiInput(p: ZkiParts): string {
  return `${p.oib}${zkiDateTime(p.issuedAt)}${p.seq}${p.premises}${p.device}${cisAmount(p.total)}`;
}

/** Iznos za QR kod: zarez i dvije decimale („1000000,00"). */
export const qrAmount = (n: number) => cisAmount(n).replace('.', ',');

/** Poveznica za provjeru računa (QR kod na računu): s JIR-om ili, dok ga nema, sa ZKI-jem. */
export function fiscalQrUrl(p: { jir?: string | null; zki?: string | null; issuedAt: Date; total: number }): string | null {
  const t = localParts(p.issuedAt);
  const datv = `${t.y}${pad(t.mo)}${pad(t.d)}_${pad(t.h)}${pad(t.mi)}`;
  if (p.jir) return `https://porezna.gov.hr/rn?jir=${p.jir}&datv=${datv}&izn=${qrAmount(p.total)}`;
  if (p.zki) return `https://porezna.gov.hr/rn?zki=${p.zki}&datv=${datv}&izn=${qrAmount(p.total)}`;
  return null;
}

// ---------------------------------------------------------------- provjere

/** Oznaka poslovnog prostora: slova i brojke, do 20 znakova. */
export const isValidPremises = (s: string | null | undefined) => /^[0-9A-Za-z]{1,20}$/.test(String(s ?? ''));
/** Oznaka naplatnog uređaja: samo brojke, do 20 znakova. */
export const isValidDevice = (s: string | null | undefined) => /^[0-9]{1,20}$/.test(String(s ?? ''));

export interface CertSummary {
  subject: string;
  issuer: string;
  validFrom?: string;
  validTo: string;
  oib: string | null;
  serial?: string;
}

export interface ReadinessInput {
  company: {
    oib: string | null;
    fiscalEnabled: boolean;
    fiscalEnv: string;
    invoicePremises: string;
    invoiceDevice: string;
    eInvoiceProvider: string;
    hasApiKey: boolean;
    cert: CertSummary | null;
  };
  /** Aktivni korisnici koji smiju izdavati račune. */
  operators: Array<{ name: string; oib: string | null }>;
  now?: Date;
}

export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  /** Upozorenje koje ne sprječava rad (npr. demo način). */
  warn?: boolean;
  hint?: string;
}

const DAY = 86_400_000;

/** Upozorenja o certifikatu: OIB različit od firme, istek. */
export function certWarnings(cert: CertSummary | null, companyOib: string | null, now = new Date()): string[] {
  if (!cert) return [];
  const out: string[] = [];
  if (cert.oib && companyOib && cert.oib !== companyOib) out.push(`OIB u certifikatu (${cert.oib}) nije OIB firme (${companyOib}).`);
  if (!cert.oib) out.push('U certifikatu nije pronađen OIB.');
  const to = new Date(cert.validTo).getTime();
  if (to < now.getTime()) out.push('Certifikat je istekao.');
  else if (to - now.getTime() < 30 * DAY) out.push(`Certifikat istječe za ${Math.ceil((to - now.getTime()) / DAY)} dana.`);
  return out;
}

/** Popis provjera za odlazak u produkciju. */
export function fiscalReadiness(i: ReadinessInput): ReadinessItem[] {
  const c = i.company;
  const now = i.now ?? new Date();
  const missingOib = i.operators.filter((o) => !isValidOib(o.oib));
  const certProblems = certWarnings(c.cert, c.oib, now);
  const certExpired = !!c.cert && new Date(c.cert.validTo).getTime() < now.getTime();
  const items: ReadinessItem[] = [
    { key: 'company-oib', label: 'OIB firme', ok: isValidOib(c.oib), hint: isValidOib(c.oib) ? c.oib! : 'Postavke → Firma: upišite ispravan OIB.' },
    {
      key: 'premises',
      label: 'Poslovni prostor i naplatni uređaj',
      ok: isValidPremises(c.invoicePremises) && isValidDevice(c.invoiceDevice),
      hint: `${c.invoicePremises} / ${c.invoiceDevice} — prostor: slova i brojke (do 20), uređaj: samo brojke. Oznaka prostora mora biti prijavljena u ePoreznoj.`,
    },
    {
      key: 'operators',
      label: 'OIB operatera (korisnika koji izdaju račune)',
      ok: missingOib.length === 0 && i.operators.length > 0,
      hint: missingOib.length ? `Nedostaje: ${missingOib.map((o) => o.name).join(', ')}` : `${i.operators.length} korisnika`,
    },
    {
      key: 'cert',
      label: 'Fiskalizacijski certifikat (FINA .p12)',
      ok: !!c.cert && !certExpired,
      warn: !c.cert && c.fiscalEnv === 'TEST' ? true : certProblems.length > 0,
      hint: c.cert
        ? [`vrijedi do ${c.cert.validTo.slice(0, 10)}`, ...certProblems].join(' · ')
        : c.fiscalEnv === 'TEST'
          ? 'Nije učitan — u testnom okruženju radi demo način (lažni JIR).'
          : 'Nije učitan — u produkciji se računi za gotovinu i kartice ne mogu izdati.',
    },
    {
      key: 'provider',
      label: 'Posrednik za eRačun',
      ok: c.eInvoiceProvider === 'demo' || (c.eInvoiceProvider !== 'none' && c.hasApiKey),
      warn: c.eInvoiceProvider === 'demo',
      hint:
        c.eInvoiceProvider === 'none'
          ? 'Nije odabran — transakcijski računi poslovnim subjektima ne šalju se kao eRačun.'
          : c.eInvoiceProvider === 'demo'
            ? 'Demo posrednik — ništa se stvarno ne šalje.'
            : c.hasApiKey
              ? 'API ključ je postavljen.'
              : 'Upišite API ključ posrednika.',
    },
    { key: 'enabled', label: 'Fiskalizacija uključena', ok: c.fiscalEnabled, hint: c.fiscalEnabled ? `okruženje ${c.fiscalEnv}` : 'Isključeno' },
  ];
  return items;
}

/** Što nedostaje da bi se račun fiskalizirao u CIS-u (prazan niz = sve je spremno). */
export function missingForCis(p: {
  companyOib: string | null;
  operatorOib: string | null;
  premises: string;
  device: string;
  hasCert: boolean;
  env: string;
}): string[] {
  const out: string[] = [];
  if (!isValidOib(p.companyOib)) out.push('OIB firme (Postavke → Firma)');
  if (!isValidOib(p.operatorOib)) out.push('OIB operatera (Postavke → Korisnici)');
  if (!isValidPremises(p.premises)) out.push('ispravna oznaka poslovnog prostora');
  if (!isValidDevice(p.device)) out.push('ispravna oznaka naplatnog uređaja (samo brojke)');
  if (!p.hasCert && p.env === 'PROD') out.push('fiskalizacijski certifikat (Postavke → Fiskalizacija)');
  return out;
}

/** Skraćivanje teksta za dnevnik. */
export const truncate = (s: string | null | undefined, max = 8000) => (s == null ? null : s.length > max ? `${s.slice(0, max)}… [+${s.length - max}]` : s);
