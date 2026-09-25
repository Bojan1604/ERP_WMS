/**
 * Popis uređaja (skladište): stupci, sortiranje, jamstvo u danima, pravila
 * brisanja i pomoć za OCR serijskih brojeva. Čista logika — bez baze i Reacta.
 */
import { daysBetween, today, type ISODate } from './dates';
import { warrantyEnd } from './pricing';

// ---------------------------------------------------------------- stupci popisa

export type ItemColumn =
  | 'status' | 'partner' | 'category' | 'brand' | 'model' | 'cpu' | 'screen' | 'os' | 'warehouse'
  | 'cost' | 'suggested' | 'sale' | 'rent' | 'import' | 'issue' | 'invoice' | 'contract' | 'warranty';

export interface ItemColumnDef {
  key: ItemColumn;
  label: string;
  /** Vidljiv dok korisnik ne odabere drukčije. */
  visible: boolean;
  /** Nabavna cijena ili iz nje izvedena vrijednost — skriva se bez prava `costs`. */
  cost?: boolean;
  num?: boolean;
}

/** Stupci popisa uređaja (serijski broj je uvijek vidljiv). Redoslijed kao u starom programu. */
export const ITEM_COLUMNS: readonly ItemColumnDef[] = [
  { key: 'status', label: 'Status', visible: true },
  { key: 'partner', label: 'Klijent', visible: true },
  { key: 'category', label: 'Kategorija', visible: true },
  { key: 'brand', label: 'Proizvođač', visible: false },
  { key: 'model', label: 'Model', visible: true },
  { key: 'cpu', label: 'Procesor', visible: false },
  { key: 'screen', label: 'Ekran', visible: false },
  { key: 'os', label: 'OS', visible: false },
  { key: 'warehouse', label: 'Skladište', visible: true },
  { key: 'cost', label: 'Nabavna', visible: true, cost: true, num: true },
  { key: 'suggested', label: 'Preporučena', visible: false, num: true },
  { key: 'sale', label: 'Prodajna', visible: false, num: true },
  { key: 'rent', label: 'Najam/mj', visible: false, num: true },
  { key: 'import', label: 'Uvoz', visible: true },
  { key: 'issue', label: 'Izdano', visible: true },
  { key: 'invoice', label: 'Račun', visible: false },
  { key: 'contract', label: 'Ugovor', visible: false },
  { key: 'warranty', label: 'Jamstvo', visible: false },
];

export const ITEM_COLUMN_KEYS = ITEM_COLUMNS.map((c) => c.key);

/** Razred zaglavlja stupca kad `<th>` ne može nositi `data-col` (npr. SortHeader). */
export const columnClass = (key: ItemColumn) => `wh-col-${key}`;

/** Stupci dostupni korisniku (bez nabavnih kad nema prava `costs`). */
export const availableColumns = (canSeeCost: boolean) => ITEM_COLUMNS.filter((c) => canSeeCost || !c.cost);

/** Zapamćeni izbor stupaca (localStorage) → skup vidljivih; nepoznati ključevi se zanemaruju. */
export function visibleColumns(saved: unknown, canSeeCost: boolean): Set<ItemColumn> {
  const avail = availableColumns(canSeeCost);
  if (!Array.isArray(saved)) return new Set(avail.filter((c) => c.visible).map((c) => c.key));
  const keys = new Set(avail.map((c) => c.key));
  return new Set(saved.filter((k): k is ItemColumn => typeof k === 'string' && keys.has(k as ItemColumn)));
}

/**
 * Sortiranje popisa uređaja — samo stupci koje baza sortira bez čitanja cijele
 * tablice (indeks ili jeftin stupac uređaja). Model, klijent, status i sl. idu
 * preko spojene tablice i na 300 000 uređaja bili bi spori, pa se ne nude.
 */
export const ITEM_SORTS = ['serijski', 'uvoz', 'izdano', 'nabavna'] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];

// ---------------------------------------------------------------- jamstvo

/**
 * Preostali dani jamstva: početak je upisani početak jamstva, datum računa ili
 * datum izdavanja; null kad uređaj nije izdan. Negativno = isteklo.
 */
export function warrantyDaysLeft(start: ISODate | null | undefined, months: number | null | undefined, now: ISODate = today()): number | null {
  if (!start || !months) return null;
  const end = warrantyEnd(start, months);
  return end ? -daysBetween(end, now) : null;
}

// ---------------------------------------------------------------- brisanje

export interface ItemLinks {
  serial: string;
  invoiceId: string | null;
  invoiceLines: number;
  onContract: boolean;
  returnedFromContract: number;
  transfers: number;
  serviceOrders: number;
}

/**
 * Zašto se uređaj ne smije obrisati (null = smije). Uređaj s računom, ugovorom
 * ili međuskladišnicom ima pravni ili skladišni trag — takav se otpisuje.
 */
export function deleteBlocker(i: ItemLinks): string | null {
  if (i.invoiceId || i.invoiceLines) return 'na računu';
  if (i.onContract || i.returnedFromContract) return 'na ugovoru o najmu';
  if (i.transfers) return 'na međuskladišnici';
  if (i.serviceOrders) return 'ima servisni nalog';
  return null;
}

/** Poruka za skupno brisanje: popis uređaja koji se ne mogu obrisati, po razlogu. */
export function deleteBlockedMessage(rows: ItemLinks[]): string | null {
  const byReason = new Map<string, string[]>();
  for (const r of rows) {
    const why = deleteBlocker(r);
    if (why) byReason.set(why, [...(byReason.get(why) ?? []), r.serial]);
  }
  if (!byReason.size) return null;
  const parts = [...byReason].map(([why, s]) => `${why}: ${s.slice(0, 10).join(', ')}${s.length > 10 ? ` i još ${s.length - 10}` : ''}`);
  return `Ovi uređaji se ne mogu obrisati (${parts.join('; ')}). Takve uređaje otpišite — povijest i dokumenti ostaju.`;
}

// ---------------------------------------------------------------- OCR

const norm = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Zamjene tipične za OCR (slovo ↔ znamenka) — svaka primijenjena na cijeli token. */
const OCR_SWAPS: Array<[RegExp, string]> = [
  [/O/g, '0'], [/0/g, 'O'], [/[IL]/g, '1'], [/1/g, 'I'], [/S/g, '5'], [/5/g, 'S'], [/B/g, '8'], [/8/g, 'B'], [/Z/g, '2'], [/2/g, 'Z'],
];

/** Prefiksi ispred serijskog broja na naljepnici (SN, S/N, SERIAL…). */
const PREFIX = /^(SERIALNO|SERIALNUMBER|SERIAL|SNR|SN)/;

/**
 * Riječi iz prepoznatog teksta koje mogu biti serijski broj: velika slova i
 * znamenke, barem 6 znakova, najviše 40 kandidata.
 */
export function ocrTokens(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.split(/\s+/)) {
    const t = norm(w);
    if (t.length < 6 || t.length > 40) continue;
    out.add(t);
    const p = t.replace(PREFIX, '');
    if (p !== t && p.length >= 6) out.add(p);
    if (out.size >= 40) break;
  }
  return [...out];
}

/** Varijante tokena za traženje u bazi (izvorni + po jedna zamjena slovo/znamenka). */
export function ocrVariants(token: string): string[] {
  const t = norm(token);
  const out = new Set([t]);
  for (const [re, to] of OCR_SWAPS) out.add(t.replace(re, to));
  return [...out].filter((v) => v.length >= 6);
}

/** Izgleda li token kao serijski broj (za nepoznate: slova i barem 4 znamenke, 8+ znakova). */
export const looksLikeSerial = (t: string) => t.length >= 8 && /\d{4}/.test(t) && /[A-Z]/.test(t);
