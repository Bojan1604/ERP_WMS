/**
 * Plan naplate u obrascima — pretvorba između redaka obrasca i zapisa na
 * ugovoru (ContractItem.plan), provjera plana i razdoblja koja su već prošla.
 * Čista logika: koristi je i klijent (PlanEditor) i poslužitelj (akcije).
 * Sami iznosi rata računaju se isključivo u `@/domain/billing`.
 */
import {
  BILLING_LABEL, deviceCharges, installmentDate,
  type BillingCode, type ContractDevice, type ContractTerms, type PlanPeriodInput,
} from '@/domain/billing';
import { addMonths, MONTHS_HR, type ISODate, type Period } from '@/domain/dates';
import { parseNumber } from '@/domain/money';

export const BILLING_CODES: BillingCode[] = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ONCE'];
export const BILLING_OPTIONS = BILLING_CODES.map((b) => ({ value: b, label: BILLING_LABEL[b] }));
export const MONTH_OPTIONS = MONTHS_HR.map((m, i) => ({ value: String(i + 1), label: m.charAt(0).toUpperCase() + m.slice(1) }));

/** Sezona razdoblja: kao na ugovoru, cijela godina ili vlastiti raspon mjeseci. */
export type SeasonMode = 'contract' | 'year' | 'custom';

export interface PlanRow {
  from: string;
  to: string;
  billing: BillingCode;
  /** Mjesečna cijena kao tekst iz polja; prazno = osnovna cijena uređaja. */
  price: string;
  season: SeasonMode;
  seasonFrom: number;
  seasonTo: number;
}

export function emptyRow(prev?: PlanRow, fallbackFrom?: ISODate): PlanRow {
  const from = prev?.from ? `${addMonths((prev.to || prev.from).slice(0, 7) + '-01', 1)}` : (fallbackFrom ?? '');
  return { from, to: '', billing: prev ? 'QUARTERLY' : 'MONTHLY', price: prev?.price ?? '', season: 'contract', seasonFrom: 4, seasonTo: 10 };
}

/** Zapis s ugovora → retci obrasca. */
export function rowsFromPlan(plan: PlanPeriodInput[] | null | undefined): PlanRow[] {
  return (plan ?? []).map((p) => ({
    from: p.from ?? '',
    to: p.to ?? '',
    billing: p.billing ?? 'MONTHLY',
    price: p.price === null || p.price === undefined ? '' : String(p.price).replace('.', ','),
    season: p.seasonFrom === null || p.seasonFrom === undefined ? 'contract' : p.seasonFrom ? 'custom' : 'year',
    seasonFrom: p.seasonFrom || 4,
    seasonTo: p.seasonTo || 10,
  }));
}

/** Retci obrasca → zapis na ugovoru (sezona 0 = izričito cijela godina). */
export function planFromRows(rows: PlanRow[]): PlanPeriodInput[] {
  return rows.map((r) => {
    const out: PlanPeriodInput = { from: r.from, billing: r.billing };
    if (r.to) out.to = r.to;
    if (r.price.trim() !== '') out.price = parseNumber(r.price);
    if (r.season === 'year') {
      out.seasonFrom = 0;
      out.seasonTo = 0;
    } else if (r.season === 'custom') {
      out.seasonFrom = r.seasonFrom;
      out.seasonTo = r.seasonTo;
    }
    return out;
  });
}

/** Provjera plana; vraća poruku greške ili null. */
export function validatePlan(plan: PlanPeriodInput[]): string | null {
  const seen = new Set<string>();
  for (const [i, p] of plan.entries()) {
    const n = `Razdoblje ${i + 1}`;
    if (!p.from || !/^\d{4}-\d{2}-\d{2}$/.test(p.from)) return `${n}: datum „od" je obavezan.`;
    if (p.to && p.to < p.from) return `${n}: datum „do" je prije datuma „od".`;
    if (seen.has(p.from)) return `${n}: dva razdoblja počinju istog dana.`;
    seen.add(p.from);
    if (p.price !== null && p.price !== undefined && (!Number.isFinite(p.price) || p.price < 0)) return `${n}: cijena ne može biti negativna.`;
    if (p.seasonFrom) {
      if (!p.seasonTo || p.seasonFrom < 1 || p.seasonFrom > 12 || p.seasonTo < 1 || p.seasonTo > 12) return `${n}: sezona mora imati mjesec od i do.`;
    }
  }
  return null;
}

/**
 * Razdoblja čija je rata već trebala biti izdana (datum rate ≤ danas) — za
 * uređaj koji se naknadno dodaje na ugovor, a računi za ta razdoblja postoje
 * izvan programa. Status ugovora se zanemaruje (i pauzirani ugovor ima prošlost).
 */
export function pastPeriods(terms: ContractTerms, device: ContractDevice, now: ISODate): Period[] {
  const c: ContractTerms = { ...terms, status: 'ACTIVE' };
  const d: ContractDevice = { ...device, status: null };
  const from = (c.startDate < (c.firstBillingDate || c.startDate) ? c.startDate : c.firstBillingDate || c.startDate).slice(0, 7);
  const planFrom = (device.plan ?? []).map((p) => p.from).filter(Boolean).sort()[0];
  const start = planFrom && planFrom.slice(0, 7) < from ? planFrom.slice(0, 7) : from;
  const out = new Set<Period>();
  for (const ch of deviceCharges(c, d, start, addMonths(now, 1).slice(0, 7))) {
    if (installmentDate(c, ch.period) <= now) out.add(ch.period);
  }
  return [...out].sort();
}

/** Kratki opis sezone: „tra–lis". */
export function seasonLabel(from?: number | null, to?: number | null): string {
  if (!from || !to) return 'cijela godina';
  const s = (m: number) => MONTHS_HR[m - 1].slice(0, 3);
  return `${s(from)}–${s(to)}`;
}
