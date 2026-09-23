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
