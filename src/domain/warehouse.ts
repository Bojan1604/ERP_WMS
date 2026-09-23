/**
 * Čista logika skladišta (bez baze i Reacta): unos serijskih brojeva, vrste statusa i nazivi.
 * Koriste je i klijent (pregled) i poslužitelj (provjera), pa je ovdje, a ne u
 * datoteci sa `server-only`.
 */

export const STATE_LABEL = {
  IN_STOCK: 'Na skladištu',
  RESERVED: 'Izašlo iz skladišta',
  SOLD: 'Prodan',
  RENTED: 'U najmu',
  SERVICE: 'Na servisu',
  RETURNING: 'U dolasku',
  WRITTEN_OFF: 'Otpisan',
  OTHER: 'Ostalo',
} as const;

export type StateKind = keyof typeof STATE_LABEL;
export const STATE_ORDER = Object.keys(STATE_LABEL) as StateKind[];

/** Stanja iz kojih uređaj smije u drugo skladište. */
export const MOVABLE_STATES: StateKind[] = ['IN_STOCK', 'RESERVED', 'SERVICE', 'OTHER'];
/** Stanja koja se ne mogu otpisati. */
export const NO_WRITE_OFF_STATES: StateKind[] = ['SOLD', 'WRITTEN_OFF'];
/** Stanja uređaja „vani" za koja se može najaviti povrat. */
export const RETURNABLE_STATES: StateKind[] = ['SOLD', 'RENTED', 'OTHER'];

export const WRITE_OFF_REASONS = ['Pokvaren', 'Izgubljen', 'Ukraden', 'Dotrajao', 'Ostalo'];

export const SERVICE_STATUS_LABEL: Record<string, string> = {
  REPORTED: 'Prijavljen',
  RECEIVED: 'Zaprimljen',
  DIAGNOSIS: 'Dijagnostika',
  AT_SUPPLIER: 'Kod dobavljača',
  REPAIRED: 'Popravljen',
  REPLACED: 'Zamijenjen',
  WRITTEN_OFF: 'Otpisan',
};

export const MAX_RECEIVE = 5000;

/** Zalijepljeni stupac → serijski brojevi: obrezani, bez praznih i bez ponavljanja (redoslijed ostaje). */
export function parseSerials(text: string): { serials: string[]; repeated: string[] } {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  const serials: string[] = [];
  for (const raw of text.split(/[\r\n\t;,]+/)) {
    const s = raw.trim();
    if (!s) continue;
    if (seen.has(s)) {
      repeated.add(s);
      continue;
    }
    seen.add(s);
    serials.push(s);
  }
  return { serials, repeated: [...repeated] };
}

/**
 * Raspon serijskih: prefiks + brojevi od..do, nadopunjeni nulama na zadanu širinu
 * (0 = bez nadopune). Npr. ('SN-', 8, 11, 4) → SN-0008 … SN-0011.
 */
export function serialRange(prefix: string, from: number, to: number, pad = 0, limit = MAX_RECEIVE): string[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return [];
  const n = Math.min(to - from + 1, limit);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`${prefix}${String(from + i).padStart(pad, '0')}`);
  return out;
}

/**
 * Duplikat serijskog je dopušten samo uz razlikovnu napomenu koja se razlikuje
 * od napomena ostalih uređaja s istim serijskim. Vraća poruku greške ili null.
 */
export function dupNoteError(serial: string, dupNote: string | null | undefined, others: Array<{ dupNote: string | null }>): string | null {
  if (!others.length) return null;
  const note = (dupNote ?? '').trim();
  if (!note) return `Serijski broj ${serial} već postoji — upišite razlikovnu napomenu.`;
  const n = note.toLowerCase();
  if (others.some((o) => (o.dupNote ?? '').trim().toLowerCase() === n)) return `Serijski broj ${serial} s napomenom „${note}" već postoji — napomena se mora razlikovati.`;
  return null;
}

export const modelName = (m: { brand?: string | null; name: string } | null | undefined) => (m ? [m.brand, m.name].filter(Boolean).join(' ') : '—');

/** Povrat na nabavnu: (zarađeno − nabavna) / nabavna u %; null bez nabavne cijene. */
export function returnOnCost(earned: number, cost: number): number | null {
  if (!cost) return null;
  return ((earned - cost) / cost) * 100;
}

// ---------------------------------------------------------------- skeniranje

/**
 * Oblici serijskog broja koje vrijedi potražiti za pročitani kod: sam kod, bez
 * nevidljivih znakova, bez uobičajenih prefiksa („S/N:", „SN "), i serijski iz
 * GS1 koda (AI 21) ako je naljepnica GS1 DataMatrix / GS1-128. Redoslijed = prednost.
 */
export function scanCandidates(code: string): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    const v = (s ?? '').trim();
    if (v && v.length <= 120 && !out.includes(v)) out.push(v);
  };
  // GS (0x1D) iz GS1 kodova čuvamo za raščlanjivanje, ostale kontrolne znakove brišemo
  const raw = code.replace(/[\u0000-\u001c\u001e\u001f\u007f]/g, '').trim();
  const clean = raw.replace(/\u001d/g, '').trim();
  add(clean);
  add(gs1Serial(raw));
  // „SN" bez razdjelnika ostaje (mnogi serijski počinju s SN), „SN:" / „S/N" / „Serial No." se skidaju
  const noPrefix = clean.replace(/^(?:s\/n\s*[:#.\-]?|sn\s*[:#.\-]|sn\s+|serial(?:\s*no\.?)?\s*[:#.\-]?|ser\.?\s*br\.?\s*[:#.\-]?)\s*/i, '');
  if (noPrefix !== clean && noPrefix.length >= 3) add(noPrefix);
  return out;
}

/** Serijski broj (AI 21) iz GS1 koda — „(01)…(21)SN" ili „01…21SN<GS>…". */
export function gs1Serial(code: string): string | null {
  const paren = /\(21\)([^()\u001d]+)/.exec(code);
  if (paren) return paren[1].trim();
  if (!/^(?:\]d2|\]C1)?01\d{14}/.test(code)) return null;
  let s = code.replace(/^(?:\]d2|\]C1)/, '');
  // fiksne duljine AI koji mogu prethoditi serijskom
  const FIXED: Record<string, number> = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6 };
  while (s.length > 2) {
    const ai = s.slice(0, 2);
    if (ai === '21') return s.slice(2).split('\u001d')[0] || null;
    if (FIXED[ai]) {
      s = s.slice(2 + FIXED[ai]);
      continue;
    }
    if (ai === '10') {
      const gs = s.indexOf('\u001d');
      if (gs < 0) return null;
      s = s.slice(gs + 1);
      continue;
    }
    return null;
  }
  return null;
}

/** QR s naljepnice ovog programa nosi poveznicu na karticu uređaja: …/skladiste/<id>. */
export function itemIdFromLink(code: string): string | null {
  const m = /\/skladiste\/(c[a-z0-9]{20,32})(?:[/?#]|$)/i.exec(code.trim());
  return m ? m[1] : null;
}

/** Oznaka uređaja s razlikovnom napomenom (za duplikate serijskog). */
export const serialLabel = (serial: string, dupNote?: string | null) => (dupNote ? `${serial} (${dupNote})` : serial);

// ---------------------------------------------------------------- inventura

/** Kako je skenirani uređaj razvrstan u inventuri. */
export type StocktakeKind = 'found' | 'unknown' | 'wrongWarehouse' | 'notInStock';

export const STOCKTAKE_KIND_LABEL: Record<StocktakeKind, string> = {
  found: 'Pronađen',
  unknown: 'Nepoznat serijski',
  wrongWarehouse: 'Iz drugog skladišta',
  notInStock: 'Nije na stanju',
};

/**
 * Razvrstavanje skeniranog uređaja: pronađen je samo uređaj na stanju u
 * skladištu inventure (ili u bilo kojem skladištu za inventuru svih skladišta).
 */
export function classifyScan(item: { state: string; warehouseId: string | null } | null, warehouseId: string | null): StocktakeKind {
  if (!item) return 'unknown';
  if (item.state !== 'IN_STOCK') return 'notInStock';
  if (warehouseId && item.warehouseId !== warehouseId) return 'wrongWarehouse';
  return 'found';
}

export interface StocktakeCounts {
  expected: number;
  found: number;
  missing: number;
  extra: number;
  scanned: number;
}

/** Brojači inventure iz očekivanog broja, broja skenova i broja pronađenih. */
export function stocktakeCounts(expected: number, scanned: number, found: number): StocktakeCounts {
  return { expected, found, missing: Math.max(0, expected - found), extra: Math.max(0, scanned - found), scanned };
}
