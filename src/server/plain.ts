import { Prisma } from '@prisma/client';

type Plain<T> = T extends Prisma.Decimal
  ? number
  : T extends Date
    ? string
    : T extends Array<infer U>
      ? Plain<U>[]
      : T extends object
        ? { [K in keyof T]: Plain<T[K]> }
        : T;

/**
 * Zapis iz baze → oblik koji se smije proslijediti klijentskoj komponenti:
 * Decimal postaje broj, Date postaje ISO niz (datumi bez vremena kao YYYY-MM-DD).
 */
export function plain<T>(v: T): Plain<T> {
  if (v === null || v === undefined) return v as Plain<T>;
  if (v instanceof Prisma.Decimal) return v.toNumber() as Plain<T>;
  if (v instanceof Date) {
    const iso = v.toISOString();
    return (iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso) as Plain<T>;
  }
  if (Array.isArray(v)) return v.map(plain) as Plain<T>;
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) out[k] = plain(x);
    return out as Plain<T>;
  }
  return v as Plain<T>;
}
