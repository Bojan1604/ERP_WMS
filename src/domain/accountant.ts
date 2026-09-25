/**
 * Knjigovođa — izlazni i ulazni računi na jednom popisu: filtri iz URL-a,
 * ključevi redaka („out:<id>" / „in:<id>") i nazivi datoteka u ZIP-u.
 */
import { formatDate, today } from './dates';

export type Direction = 'out' | 'in';
export type AccountantKind = 'INVOICE' | 'ADVANCE' | 'STORNO' | 'CREDIT_NOTE' | 'INBOUND';

export const ACCOUNTANT_KIND_LABEL: Record<AccountantKind, string> = {
  INVOICE: 'Račun',
  ADVANCE: 'Predujam',
  STORNO: 'Storno',
  CREDIT_NOTE: 'Odobrenje',
  INBOUND: 'Ulazni račun',
};

/** Najviše redaka po smjeru u jednom zahtjevu (popis, ZIP, ispis). */
export const ACCOUNTANT_ROW_CAP = 2000;

export interface AccountantFilters {
  from: string;
  to: string;
  /** '' = oba smjera */
  dir: '' | Direction;
  /** '' = svi, 'da' = poslano, 'ne' = nije poslano */
  sent: '' | 'da' | 'ne';
  kind: '' | AccountantKind;
  q: string;
}

type Params = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v.trim() : '');
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Zadano razdoblje: od prvog u tekućem mjesecu do danas. */
export function readAccountantFilters(sp: Params, now = today()): AccountantFilters {
  const from = str(sp.od);
  const to = str(sp.do);
  const dir = str(sp.smjer);
  const sent = str(sp.poslano);
  const kind = str(sp.vrsta);
  return {
    from: isDate(from) ? from : `${now.slice(0, 7)}-01`,
    to: isDate(to) ? to : now,
    dir: dir === 'izlazni' ? 'out' : dir === 'ulazni' ? 'in' : '',
    sent: sent === 'da' || sent === 'ne' ? sent : '',
    kind: Object.hasOwn(ACCOUNTANT_KIND_LABEL, kind) ? (kind as AccountantKind) : '',
    q: str(sp.q).slice(0, 100),
  };
}

/** Koji smjerovi ulaze u popis — vrsta dokumenta sužava smjer (ulazni račun je samo ulazni). */
export function directionsOf(f: Pick<AccountantFilters, 'dir' | 'kind'>): { out: boolean; in: boolean } {
  const byKind = f.kind === 'INBOUND' ? 'in' : f.kind ? 'out' : '';
  return {
    out: (f.dir === '' || f.dir === 'out') && byKind !== 'in',
    in: (f.dir === '' || f.dir === 'in') && byKind !== 'out',
  };
}

export const rowKey = (dir: Direction, id: string) => `${dir}:${id}`;

/** „out:a,in:b" ili niz ključeva → id-evi po smjeru (nepoznati i duplikati se odbacuju). */
export function parseKeys(keys: string[] | string): { out: string[]; in: string[] } {
  const list = Array.isArray(keys) ? keys : keys.split(',');
  const out = new Set<string>();
  const inb = new Set<string>();
  for (const k of list) {
    const m = /^(out|in):([A-Za-z0-9_-]{1,64})$/.exec(k.trim());
    if (m) (m[1] === 'out' ? out : inb).add(m[2]);
  }
  return { out: [...out], in: [...inb] };
}

/** Naziv datoteke/mape iz broja računa: kose crte postaju crtice, ostalo čisti ZIP. */
export const fileStem = (number: string | null | undefined, fallback: string) =>
  (number ?? '').trim().replace(/[\\/]+/g, '-').slice(0, 80) || fallback;

export interface AccountantCsvRow {
  dir: Direction;
  date: string;
  number: string;
  partner: string;
  oib: string | null;
  kind: AccountantKind;
  net: number;
  vat: number;
  total: number;
  status: string;
}

export const ACCOUNTANT_CSV_COLUMNS: Array<{ label: string; value: (r: AccountantCsvRow) => string | number | null }> = [
  { label: 'Smjer', value: (r) => (r.dir === 'out' ? 'Izlazni' : 'Ulazni') },
  { label: 'Datum', value: (r) => formatDate(r.date) },
  { label: 'Broj', value: (r) => r.number },
  { label: 'Partner', value: (r) => r.partner },
  { label: 'OIB', value: (r) => r.oib },
  { label: 'Vrsta', value: (r) => ACCOUNTANT_KIND_LABEL[r.kind] },
  { label: 'Osnovica', value: (r) => r.net },
  { label: 'PDV', value: (r) => r.vat },
  { label: 'Ukupno', value: (r) => r.total },
  { label: 'Status', value: (r) => r.status },
];

/** Stanje eRačuna za stupac „eRačun": izlazni (stanje kod posrednika) ili ulazni preuzet od posrednika. */
export function accountantEInvoiceLabel(e: string | null | undefined): string {
  if (!e) return '';
  if (e === 'INBOUND') return 'ulazni eRačun';
  const map: Record<string, string> = {
    PENDING: 'u slanju',
    SENT: 'poslan',
    DELIVERED: 'dostavljen',
    ACCEPTED: 'prihvaćen',
    REJECTED: 'odbijen',
    PAID: 'plaćen',
    ERROR: 'greška',
    FAILED: 'greška',
  };
  return `eRačun · ${map[e] ?? e.toLowerCase()}`;
}
