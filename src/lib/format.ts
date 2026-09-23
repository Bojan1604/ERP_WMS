import { formatDate } from '@/domain/dates';

const money = new Intl.NumberFormat('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('hr-HR', { maximumFractionDigits: 0 });
const dec = new Intl.NumberFormat('hr-HR', { maximumFractionDigits: 2 });

/** 1234.5 → „1.234,50 €" */
export function eur(v: number | null | undefined, currency = '€'): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${money.format(v)} ${currency}`;
}
export const amount = (v: number | null | undefined) => (v === null || v === undefined ? '—' : money.format(v));
export const integer = (v: number) => int.format(v);
export const decimal = (v: number) => dec.format(v);
export const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${dec.format(v)} %`);
export const date = formatDate;
export function dateTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('hr-HR', { timeZone: 'Europe/Zagreb', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
}
