/**
 * Čitanje odgovora javnih registara u podatke partnera. Čiste funkcije (bez
 * mreže) — dohvat je u src/server/lookup, ovdje samo tumačenje odgovora.
 */

export interface CompanyInfo {
  found: boolean;
  source: 'sudreg' | 'vies';
  name: string;
  fullName: string;
  street: string;
  zip: string;
  city: string;
  email: string;
  legalForm: string;
  mbs: string;
  status: string;
  active: boolean;
  /** PDV ID ako je VIES potvrdio da je obveznik PDV-a. */
  vatId: string;
}

const empty = (source: CompanyInfo['source']): CompanyInfo => ({
  found: false, source, name: '', fullName: '', street: '', zip: '', city: '', email: '', legalForm: '', mbs: '', status: '', active: true, vatId: '',
});

type Obj = Record<string, unknown>;
const get = (o: unknown, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = k.split('.').reduce<unknown>((x, p) => (x == null || typeof x !== 'object' ? undefined : (x as Obj)[p]), o);
    if (v != null && v !== '') return v;
  }
  return '';
};
/** Kod povijesnih nizova registra zadnji element je važeći. */
const last = (v: unknown): Obj => (Array.isArray(v) ? ((v[v.length - 1] as Obj) ?? {}) : ((v as Obj) ?? {}));
const str = (v: unknown) => (v == null ? '' : String(v)).trim();

/**
 * Sudski registar (sudreg-data.gov.hr, API v3 `javni/detalji_subjekta`). Nazivi
 * polja razlikuju se po verzijama pa se čita više mogućih.
 */
export function parseSudreg(d: unknown): CompanyInfo {
  const out = empty('sudreg');
  if (!d || typeof d !== 'object') return out;
  const tvrtka = last(get(d, 'tvrtka', 'tvrtke'));
  const skracena = last(get(d, 'skracena_tvrtka', 'skracene_tvrtke'));
  const fullName = str(get(tvrtka, 'ime', 'naziv') || get(d, 'naziv', 'ime'));
  const shortName = str(get(skracena, 'ime', 'naziv'));
  const s0 = last(get(d, 'sjediste', 'sjedista'));
  const street = [str(get(s0, 'ulica', 'naziv_ulice')), [str(get(s0, 'kucni_broj', 'kucniBroj', 'broj')), str(get(s0, 'kucni_podbroj'))].join('')]
    .filter(Boolean)
    .join(' ');
  const emails = get(d, 'email_adrese', 'email_adresa');
  const email = typeof emails === 'string' ? emails : str(get(last(emails), 'adresa'));
  const pravni = last(get(d, 'pravni_oblik', 'pravni_oblici'));
  const statusRaw = str(get(d, 'status', 'stanje'));
  const postupak = last(get(d, 'postupci', 'postupak'));
  const uPostupku = Number(get(postupak, 'postupak')) > 1; // 1 = nema postupka; 2 stečaj, 3 likvidacija…
  const status = statusRaw === '1' ? 'aktivan' : statusRaw === '2' ? 'brisan' : statusRaw;
  return {
    ...out,
    found: !!(fullName || shortName),
    // skraćena tvrtka („KLC Tech d.o.o.") je uobičajeni naziv na računu
    name: shortName || fullName,
    fullName,
    street,
    zip: str(get(s0, 'postanski_broj', 'postanskiBroj', 'posta.postanski_broj')),
    city: str(get(s0, 'naziv_naselja', 'nazivNaselja', 'naselje_van_sifrarnika', 'naselje', 'grad')),
    email,
    legalForm: str(get(pravni, 'vrsta_pravnog_oblika.kratica', 'vrsta_pravnog_oblika.naziv', 'kratica')),
    mbs: str(get(d, 'mbs')),
    status: status + (uPostupku ? ' — u postupku (stečaj/likvidacija)' : ''),
    active: status !== 'brisan' && !get(d, 'datum_brisanja') && !uPostupku,
  };
}

/** Greška registra: `[{ error_code, error_message }]`; 505 = OIB nije u registru. */
export function sudregError(d: unknown): { code: number; message: string } | null {
  const e = Array.isArray(d) && d[0] && typeof d[0] === 'object' && 'error_code' in d[0] ? d[0] : d && typeof d === 'object' && 'error_code' in d ? d : null;
  return e ? { code: Number((e as Obj).error_code), message: str((e as Obj).error_message) } : null;
}

/**
 * VIES (EU, bez prijave): naziv i adresa obveznika PDV-a. Adresa je jedan tekst,
 * za HR obično „ULICA 1, 10000 GRAD" ili u dva retka.
 */
export function parseVies(d: unknown, country: string, number: string): CompanyInfo {
  const out = empty('vies');
  if (!d || typeof d !== 'object') return out;
  const valid = (d as Obj).isValid === true || (d as Obj).valid === true;
  const name = str((d as Obj).name).replace(/^-+$/, '');
  if (!valid) return out;
  const address = str((d as Obj).address).replace(/^-+$/, '');
  const parts = address.split(/\n|,\s*/).map((s) => s.trim()).filter(Boolean);
  let street = '';
  let zip = '';
  let city = '';
  const zipIdx = parts.findIndex((p) => /^\d{5}\s+\S/.test(p));
  if (zipIdx >= 0) {
    const m = /^(\d{5})\s+(.+)$/.exec(parts[zipIdx])!;
    zip = m[1];
    city = titleCase(m[2]);
    street = titleCase(parts.slice(0, zipIdx).join(', '));
  } else street = titleCase(address.replace(/\n/g, ', '));
  return { ...out, found: true, name: titleCase(name), fullName: name, street, zip, city, status: 'obveznik PDV-a', vatId: `${country}${number}` };
}

/** „KLC TECH D.O.O." → „Klc Tech d.o.o." — VIES vraća sve velikim slovima. */
export function titleCase(s: string): string {
  if (!s || s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-/("„])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())
    .replace(/\bD\.O\.O\./gi, 'd.o.o.')
    .replace(/\bJ\.D\.O\.O\./gi, 'j.d.o.o.')
    .replace(/\bD\.D\./gi, 'd.d.');
}

/** AMS (adresar primatelja eRačuna): tumačenje odgovora posrednika. */
export function amsRegistered(status: number, d: unknown): boolean {
  if (!d || typeof d !== 'object') return status === 200;
  const o = d as Obj;
  const v = o.registered ?? o.exists ?? o.found ?? o.isRegistered ?? o.result;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^(true|yes|da|registered|found)$/i.test(v);
  return status === 200 && !o.error && !o.message;
}
