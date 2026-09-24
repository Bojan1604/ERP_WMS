import 'server-only';
import { db } from '../db';
import { decryptSecret } from '../fiscal/crypto';
import { providerFor } from '../fiscal/einvoice';
import { parseSudreg, parseVies, sudregError, type CompanyInfo } from '@/domain/company-lookup';
import { isValidOib } from '@/domain/tax';

/**
 * „Dohvati" na partneru: podaci firme iz Sudskog registra (ili VIES-a) i provjera
 * u AMS-u (može li primati eRačune) preko posrednika firme.
 *
 * Sudski registar traži pristup (besplatna registracija na sudreg-data.gov.hr):
 *   SUDREG_CLIENT_ID, SUDREG_CLIENT_SECRET   (neobvezno SUDREG_TOKEN_URL, SUDREG_LOOKUP_URL s {oib})
 * Bez njih se koristi VIES (EU registar obveznika PDV-a, bez prijave).
 */

const TIMEOUT_MS = 12_000;

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; data: unknown }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

const netError = (who: string, e: unknown) =>
  e instanceof Error && e.name === 'AbortError' ? `${who} ne odgovara (${TIMEOUT_MS / 1000} s).` : `${who} nije dostupan: ${e instanceof Error ? e.message : e}`;

// ---------------------------------------------------------------- Sudski registar

let token: { value: string; until: number } | null = null;

export const sudregConfigured = () => !!(process.env.SUDREG_CLIENT_ID && process.env.SUDREG_CLIENT_SECRET);

async function sudregToken(): Promise<string> {
  if (token && token.until > Date.now()) return token.value;
  const id = process.env.SUDREG_CLIENT_ID ?? '';
  const secret = process.env.SUDREG_CLIENT_SECRET ?? '';
  const url = process.env.SUDREG_TOKEN_URL || 'https://sudreg-data.gov.hr/api/oauth/token';
  const r = await fetchJson(url, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const d = r.data as { access_token?: string; expires_in?: number } | null;
  if (r.status !== 200 || !d?.access_token) throw new Error(`Sudski registar nije izdao pristup (HTTP ${r.status}) — provjerite SUDREG_CLIENT_ID i SUDREG_CLIENT_SECRET.`);
  token = { value: d.access_token, until: Date.now() + Math.max(60, (d.expires_in ?? 3600) - 60) * 1000 };
  return token.value;
}

export async function lookupSudreg(oib: string): Promise<CompanyInfo & { error?: string }> {
  const url = (process.env.SUDREG_LOOKUP_URL || 'https://sudreg-data.gov.hr/api/javni/detalji_subjekta?tip_identifikatora=oib&identifikator={oib}&expand_relations=true').replace('{oib}', oib);
  const r = await fetchJson(url, { headers: { Authorization: `Bearer ${await sudregToken()}` } });
  if (r.status === 401) token = null;
  const err = sudregError(r.data);
  if (r.status === 404 || err?.code === 505) return { ...parseSudreg(null), error: 'OIB nije u Sudskom registru (obrti i udruge se ne vode u njemu).' };
  if (err) return { ...parseSudreg(null), error: `Sudski registar: ${err.message || 'greška'} (${err.code})` };
  if (r.status !== 200) return { ...parseSudreg(null), error: `Sudski registar: HTTP ${r.status}` };
  return parseSudreg(r.data);
}

// ---------------------------------------------------------------- VIES

export async function lookupVies(country: string, number: string): Promise<CompanyInfo & { error?: string }> {
  const cc = country === 'GR' ? 'EL' : country;
  const url = (process.env.VIES_URL || 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{cc}/vat/{num}').replace('{cc}', cc).replace('{num}', encodeURIComponent(number));
  const r = await fetchJson(url);
  const d = r.data as { userError?: string } | null;
  if (r.status !== 200) return { ...parseVies(null, cc, number), error: `VIES: HTTP ${r.status}` };
  if (d?.userError && !/^VALID$/i.test(d.userError) && !/INVALID/i.test(d.userError)) {
    return { ...parseVies(null, cc, number), error: `VIES trenutno ne odgovara za ${cc} (${d.userError}).` };
  }
  const info = parseVies(r.data, cc, number);
  return info.found ? info : { ...info, error: `${cc}${number} nije obveznik PDV-a u VIES-u.` };
}

// ---------------------------------------------------------------- AMS

export interface AmsResult {
  checked: boolean;
  registered?: boolean;
  demo?: boolean;
  error?: string;
}

async function amsCheck(companyId: string, oib: string): Promise<AmsResult> {
  const c = await db.company.findUnique({ where: { id: companyId }, select: { eInvoiceProvider: true, eInvoiceApiKey: true, fiscalEnv: true } });
  if (!c) return { checked: false };
  const p = providerFor(c.eInvoiceProvider, decryptSecret(c.eInvoiceApiKey), c.fiscalEnv);
  if (!p?.amsCheck) return { checked: false };
  const r = await p.amsCheck(oib);
  return r.ok ? { checked: true, registered: !!r.registered, demo: r.demo } : { checked: true, error: r.error };
}

// ---------------------------------------------------------------- zajedno

export interface PartnerLookup {
  info: (CompanyInfo & { error?: string }) | null;
  ams: AmsResult;
  /** Upozorenja za korisnika (npr. registar nije podešen). */
  notes: string[];
}

/** OIB (HR) ili PDV ID strane firme (npr. SI12345678). */
export async function lookupPartner(companyId: string, input: { oib: string | null; vatId: string | null; country: string }): Promise<PartnerLookup> {
  const notes: string[] = [];
  const oib = (input.oib ?? '').replace(/\s+/g, '');
  const vat = (input.vatId ?? '').replace(/[\s.-]+/g, '').toUpperCase();
  const hrOib = /^\d{11}$/.test(oib) ? oib : /^HR\d{11}$/.test(vat) ? vat.slice(2) : '';

  if (hrOib) {
    if (!isValidOib(hrOib)) return { info: null, ams: { checked: false }, notes: ['OIB nije ispravan (kontrolna znamenka).'] };
    const [info, ams] = await Promise.all([
      (async () => {
        let reg: (CompanyInfo & { error?: string }) | null = null;
        if (sudregConfigured()) {
          try {
            reg = await lookupSudreg(hrOib);
          } catch (e) {
            reg = { ...parseSudreg(null), error: e instanceof Error && /Sudski registar/.test(e.message) ? e.message : netError('Sudski registar', e) };
          }
          if (reg.found) return reg;
        } else notes.push('Sudski registar nije podešen (SUDREG_CLIENT_ID / SUDREG_CLIENT_SECRET) — podaci su iz VIES-a.');
        // obrti, udruge i firme kad registar ne odgovara: VIES (samo obveznici PDV-a)
        try {
          const v = await lookupVies('HR', hrOib);
          if (v.found) {
            if (reg?.error) notes.push(reg.error);
            return v;
          }
          return reg?.found === false && reg.error ? { ...reg, error: [reg.error, v.error].filter(Boolean).join(' ') } : v;
        } catch (e) {
          return reg ?? { ...parseVies(null, 'HR', hrOib), error: netError('VIES', e) };
        }
      })(),
      amsCheck(companyId, hrOib).catch((e): AmsResult => ({ checked: true, error: netError('Posrednik', e) })),
    ]);
    return { info, ams, notes };
  }

  const m = /^([A-Z]{2})([0-9A-Z+*]{2,12})$/.exec(vat);
  if (m && m[1] !== 'HR') {
    try {
      return { info: await lookupVies(m[1], m[2]), ams: { checked: false }, notes };
    } catch (e) {
      return { info: { ...parseVies(null, m[1], m[2]), error: netError('VIES', e) }, ams: { checked: false }, notes };
    }
  }
  return { info: null, ams: { checked: false }, notes: ['Upišite OIB (11 znamenaka) ili PDV ID strane firme (npr. SI12345678).'] };
}
