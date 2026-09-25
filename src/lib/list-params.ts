/**
 * Čitanje parametara popisa iz URL-a (searchParams stranice ili API rute) —
 * sigurno: višestruki odabir se reže na dopuštene vrijednosti, sortiranje ide
 * samo po stupcima s popisa (whitelist), datumi samo u obliku YYYY-MM-DD.
 *
 * Konvencije (iste kao u src/components/ui/filters.tsx i sort-header.tsx):
 *   ?partner=a,b,c        više vrijednosti jednog filtra, odvojene zarezom; zarez UNUTAR vrijednosti
 *                         piše se „\," (a „\" kao „\\") — `joinMulti` / `splitMulti`; radi i ?cpu=a&cpu=b
 *   ?sort=kolona&dir=asc  sortiranje (dir: asc | desc)
 *   ?od=YYYY-MM-DD&do=YYYY-MM-DD   raspon datuma (oba neobavezna)
 */
export type SearchParams = Record<string, string | string[] | undefined>;
export type SortDir = 'asc' | 'desc';

type Source = SearchParams | URLSearchParams;

/**
 * Više vrijednosti → jedan parametar: zarez i obrnuta kosa crta unutar vrijednosti se
 * „escapeaju" (CPU „ARM Cortex-A53, 4 jezgre" ostaje jedna vrijednost).
 */
export const joinMulti = (values: readonly string[]) => values.map((v) => v.replace(/\\/g, '\\\\').replace(/,/g, '\\,')).join(',');

/** Obrat `joinMulti`: dijeli po zarezima koji nisu „escapeani". Stari URL-ovi (bez „\") čitaju se isto. */
export function splitMulti(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length && (raw[i + 1] === ',' || raw[i + 1] === '\\')) {
      cur += raw[++i];
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const get = (sp: Source, name: string): string => {
  const v = sp instanceof URLSearchParams ? sp.get(name) : sp[name];
  if (Array.isArray(v)) return v.join(',');
  return typeof v === 'string' ? v : '';
};

/** Jedna vrijednost parametra (obrezana), '' ako je nema. */
export const paramStr = (sp: Source, name: string) => get(sp, name).trim();

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Kalendarski ispravan datum YYYY-MM-DD (2026-02-30 i 2026-13-45 nisu). */
export const isIsoDate = (v: string) => {
  if (!ISO.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/**
 * Više vrijednosti iz jednog parametra (`?status=a,b`). Prazne i ponovljene se
 * izbacuju; s `allowed` ostaju samo dopuštene (npr. vrijednosti enuma).
 * Najviše 200 vrijednosti — zaštita od predugog upita.
 */
export function parseMulti<T extends string = string>(sp: Source, name: string, allowed?: readonly T[]): T[] {
  // ponovljeni parametar (?cpu=a&cpu=b) — svaki dio je zaseban popis
  const v0 = sp instanceof URLSearchParams ? sp.getAll(name) : sp[name];
  const raws = (Array.isArray(v0) ? v0 : [v0]).filter((x): x is string => typeof x === 'string' && x !== '');
  if (!raws.length) return [];
  const out = new Set<string>();
  for (const part of raws.flatMap(splitMulti)) {
    const v = part.trim();
    if (!v || v.length > 200) continue;
    if (allowed && !allowed.includes(v as T)) continue;
    out.add(v);
    if (out.size >= 200) break;
  }
  return [...out] as T[];
}

/** Prisma uvjet za višestruki odabir: undefined kad ništa nije odabrano (filtar se ne primjenjuje). */
export const inOrAll = <T>(values: T[]): { in: T[] } | undefined => (values.length ? { in: values } : undefined);

/**
 * Sortiranje iz `?sort=&dir=` — samo po stupcima iz `allowed`; inače `fallback`
 * (ili null = zadani redoslijed popisa).
 */
export function parseSort<K extends string>(
  sp: Source,
  allowed: readonly K[],
  fallback: { sort: K; dir: SortDir } | null = null,
): { sort: K; dir: SortDir } | null {
  const sort = paramStr(sp, 'sort') as K;
  if (!sort || !allowed.includes(sort)) return fallback;
  const dir = paramStr(sp, 'dir') === 'desc' ? 'desc' : 'asc';
  return { sort, dir };
}

/**
 * Prisma `orderBy` iz sortiranja: `map` za svaki dopušteni stupac daje redoslijed
 * za smjer. Uvijek dodaje `tieBreak` (npr. `{ id: 'asc' }`) da straničenje bude stabilno.
 *
 *   const s = parseSort(sp, ['datum', 'partner'] as const, { sort: 'datum', dir: 'desc' });
 *   orderBy: sortOrderBy(s, { datum: (d) => ({ date: d }), partner: (d) => ({ partner: { name: d } }) }, { id: 'asc' })
 */
export function sortOrderBy<K extends string, O>(
  s: { sort: K; dir: SortDir } | null,
  map: Record<K, (dir: SortDir) => O | O[]>,
  tieBreak?: NoInfer<O>,
): O[] | undefined {
  if (!s) return tieBreak ? [tieBreak] : undefined;
  const o = map[s.sort](s.dir);
  const list = Array.isArray(o) ? o : [o];
  return tieBreak ? [...list, tieBreak] : list;
}

/** Raspon datuma `?od=&do=` (YYYY-MM-DD); neispravan datum se zanemaruje, obrnut raspon se okreće. */
export function parseDateRange(sp: Source, fromName = 'od', toName = 'do'): { from: string | null; to: string | null } {
  let from: string | null = paramStr(sp, fromName) || null;
  let to: string | null = paramStr(sp, toName) || null;
  if (from && !isIsoDate(from)) from = null;
  if (to && !isIsoDate(to)) to = null;
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to };
}

/**
 * Prisma uvjet za stupac tipa @db.Date iz raspona (uključivo s obje strane);
 * undefined kad raspon nije zadan.
 */
export function dateRangeWhere(r: { from: string | null; to: string | null }): { gte?: Date; lte?: Date } | undefined {
  if (!r.from && !r.to) return undefined;
  return {
    ...(r.from ? { gte: new Date(`${r.from}T00:00:00Z`) } : {}),
    ...(r.to ? { lte: new Date(`${r.to}T00:00:00Z`) } : {}),
  };
}

/** Upit bez `page` (i po želji drugih ključeva) — za poveznice izvoza i sortiranja. */
export function queryWithout(sp: Source, drop: string[] = ['page']): URLSearchParams {
  const q = new URLSearchParams();
  const entries = sp instanceof URLSearchParams ? [...sp.entries()] : Object.entries(sp);
  for (const [k, v] of entries) {
    if (drop.includes(k)) continue;
    const s = Array.isArray(v) ? v.join(',') : v;
    if (typeof s === 'string' && s) q.set(k, s);
  }
  return q;
}
