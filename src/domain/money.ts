/**
 * Novčana aritmetika. Iznosi se zaokružuju „half away from zero" na cent, uz
 * korekciju binarne reprezentacije (1.005 → 1.01, a ne 1.00).
 */
export type Numeric = number | string | { toNumber(): number } | null | undefined;

export function num(v: Numeric): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') return parseNumber(v);
  return v.toNumber();
}

export function round(value: number, scale = 2): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** scale;
  const shifted = Number.parseFloat((value * f).toPrecision(15));
  return (shifted < 0 ? -Math.round(-shifted) : Math.round(shifted)) / f;
}

export const r2 = (v: number) => round(v, 2);

export function sum<T>(rows: readonly T[], pick: (row: T) => number): number {
  let s = 0;
  for (const row of rows) s += pick(row);
  return r2(s);
}

/**
 * Čita broj kako ga ljudi upisuju: „1.500,00" → 1500, „220.85" → 220.85,
 * „1.500.000" → 1500000, „12,5" → 12.5.
 */
export function parseNumber(input: string): number {
  const n = Number.parseFloat(normalizeNumber(input));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Stroga inačica `parseNumber` za obrasce: cijeli upis mora biti broj
 * („1.234,56", „12,5", „-3", „1 500 €"); „abc", „12x" ili prazno daju NaN — iznos se
 * tada odbija („Neispravan iznos"), umjesto da se tiho spremi 0.
 */
export function parseAmount(input: string): number {
  const s = normalizeNumber(input);
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s) ? Number(s) : Number.NaN;
}

/** Hrvatski/engleski zapis broja → „1234.56" (bez razmaka, valute i tisućica). */
function normalizeNumber(input: string): string {
  let s = String(input).trim().replace(/\s|€|eur|%/gi, '');
  if (!s) return '';
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    // zadnji znak je decimalni, drugi je tisućica
    s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (comma >= 0) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, '');
  }
  return s;
}
