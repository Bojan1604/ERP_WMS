/**
 * Hrvatska množina uz broj: 1, 21, 31… → `one` („1 stavka"), 2–4, 22–24… → `few`
 * („3 stavke"), ostalo (0, 5–20, 25…, 11–14) → `many` („5 stavki").
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n));
  const d = a % 10;
  const h = a % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
}

/**
 * Broj s imenicom u pravom obliku: `countLabel(3, 'stavka', 'stavke', 'stavki')` → „3 stavke".
 * `format` oblikuje broj (npr. `integer` iz lib/format za „1.234 stavke").
 */
export function countLabel(n: number, one: string, few: string, many: string, format: (n: number) => string = String): string {
  return `${format(n)} ${plural(n, one, few, many)}`;
}
