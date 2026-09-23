/**
 * Datumi u domeni su nizovi `YYYY-MM-DD` (kalendarski dan, bez vremenske zone),
 * a razdoblja `YYYY-MM`. Tako se izbjegavaju pomaci od ponoći koje unosi `Date`.
 */
export type ISODate = string;
export type Period = string;

const pad = (n: number) => String(n).padStart(2, '0');

export const TIME_ZONE = 'Europe/Zagreb';

/** Današnji datum u zoni firme. */
export function today(now: Date = new Date()): ISODate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function toISO(d: Date | string | null | undefined): ISODate | '' {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** ISO datum → Date u UTC ponoć (oblik koji Prisma očekuje za @db.Date). */
export function fromISO(s: ISODate): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
}

export function parts(d: ISODate): [number, number, number] {
  return [Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))];
}

export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function ymd(year: number, month: number, day: number): ISODate {
  // normalizacija mjeseca izvan 1–12
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  return `${y}-${pad(m)}-${pad(Math.min(day, lastDayOfMonth(y, m)))}`;
}

export function addDays(d: ISODate, days: number): ISODate {
  const t = fromISO(d);
  t.setUTCDate(t.getUTCDate() + days);
  return toISO(t);
}

/** Dodaje mjesece; dan se reže na zadnji dan ciljnog mjeseca (31.1. + 1 = 28./29.2.). */
export function addMonths(d: ISODate, months: number): ISODate {
  const [y, m, day] = parts(d);
  return ymd(y, m + months, day);
}

export function daysBetween(from: ISODate, to: ISODate = today()): number {
  return Math.round((fromISO(to).getTime() - fromISO(from).getTime()) / 86_400_000);
}

/** Broj kalendarskih mjeseci koje razdoblje dodiruje (najmanje 1). */
export function monthsBetween(from: ISODate, to: ISODate | '' | null | undefined): number {
  if (!from || !to) return 1;
  const [ay, am] = parts(from);
  const [by, bm] = parts(to);
  return Math.max(1, (by - ay) * 12 + (bm - am) + 1);
}

export const periodOf = (d: ISODate): Period => d.slice(0, 7);
export const periodStart = (p: Period): ISODate => `${p}-01`;
export function periodEnd(p: Period): ISODate {
  const [y, m] = [Number(p.slice(0, 4)), Number(p.slice(5, 7))];
  return ymd(y, m, 31);
}
export const period = (year: number, month0: number): Period => `${year}-${pad(month0 + 1)}`;

export const MONTHS_HR = [
  'siječanj', 'veljača', 'ožujak', 'travanj', 'svibanj', 'lipanj',
  'srpanj', 'kolovoz', 'rujan', 'listopad', 'studeni', 'prosinac',
];
export const MONTHS_SHORT = ['sij', 'velj', 'ožu', 'tra', 'svi', 'lip', 'srp', 'kol', 'ruj', 'lis', 'stu', 'pro'];

export function periodLabel(p: Period): string {
  return `${MONTHS_HR[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}.`;
}

/** 2026-03-05 → 05.03.2026. */
export function formatDate(d: ISODate | Date | null | undefined): string {
  const s = toISO(d ?? null);
  if (!s) return '—';
  return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}.`;
}
