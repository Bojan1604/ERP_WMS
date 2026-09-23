import { addDays, addMonths, monthsBetween, parts, period as mkPeriod, periodStart, today, ymd, type ISODate, type Period } from './dates';
import { r2 } from './money';

/**
 * Motor naplate najma.
 *
 * Jedinična cijena najma je UVIJEK mjesečna. Rata je mjesečna cijena × broj
 * mjeseci koje naplata pokriva (kvartalno 3, polugodišnje 6, godišnje 12, a
 * jednokratno broj mjeseci razdoblja). Iznos rate se nigdje ne pamti.
 *
 * Svaki uređaj na ugovoru ima PLAN NAPLATE — niz razdoblja s vlastitom
 * učestalošću, cijenom i sezonom. Razdoblje traje do vlastitog „do", do dana
 * prije početka sljedećeg ili do kraja ugovora — što nastupi prvo. Uređaj bez
 * plana slijedi uvjete ugovora.
 */

export type BillingCode = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL' | 'ONCE';
export type BillingModeCode = 'IN_ADVANCE' | 'IN_ARREARS';
export type ContractStatusCode = 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'TERMINATED';

export const BILLING_MONTHS: Record<BillingCode, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  ANNUAL: 12,
  ONCE: 0,
};

export const BILLING_LABEL: Record<BillingCode, string> = {
  MONTHLY: 'Mjesečno',
  QUARTERLY: 'Kvartalno',
  SEMIANNUAL: 'Polugodišnje',
  ANNUAL: 'Godišnje',
  ONCE: 'Jednokratno',
};

export const BILLING_MODE_LABEL: Record<BillingModeCode, string> = {
  IN_ADVANCE: 'Unaprijed — na početku razdoblja',
  IN_ARREARS: 'Unatrag — po isteku razdoblja',
};

export const CONTRACT_STATUS_LABEL: Record<ContractStatusCode, string> = {
  ACTIVE: 'Aktivan',
  PAUSED: 'Pauziran',
  EXPIRED: 'Istekao',
  TERMINATED: 'Raskinut',
};

export interface Season {
  from: number; // 1–12
  to: number;
}

export interface ContractTerms {
  status: ContractStatusCode;
  startDate: ISODate;
  endDate?: ISODate | null;
  firstBillingDate?: ISODate | null;
  billingDay?: number | null;
  billing: BillingCode;
  billingMode: BillingModeCode;
  seasonFrom?: number | null;
  seasonTo?: number | null;
}

export interface PlanPeriodInput {
  from?: ISODate | null;
  to?: ISODate | null;
  billing?: BillingCode | null;
  /** Mjesečna cijena u razdoblju; prazno = osnovna cijena uređaja. */
  price?: number | null;
  seasonFrom?: number | null;
  seasonTo?: number | null;
}

export interface ContractDevice {
  itemId: string;
  monthly: number;
  plan?: PlanPeriodInput[] | null;
  status?: ContractStatusCode | null;
  skipped?: Period[] | null;
}

export interface PlanPeriod {
  from: ISODate;
  /** Stvarni kraj razdoblja ('' = bez kraja). */
  to: ISODate | '';
  billing: BillingCode;
  price: number;
  season: Season | null;
}

export interface Charge {
  period: Period;
  amount: number;
  billing: BillingCode;
  /** Broj mjeseci koje rata pokriva. */
  months: number;
  /** Mjesečna cijena na kojoj se temelji. */
  monthly: number;
}

// ---------------------------------------------------------------- pomoćne

export const billingMonths = (b: BillingCode) => BILLING_MONTHS[b] ?? 1;

const seasonOf = (from?: number | null, to?: number | null): Season | null =>
  from && to ? { from, to } : null;

/** Je li mjesec (1–12) u sezoni; sezona može prelaziti prijelom godine. */
export function inSeason(season: Season | null, month: number): boolean {
  if (!season) return true;
  const { from, to } = season;
  return from <= to ? month >= from && month <= to : month >= from || month <= to;
}

export function deviceStatus(c: ContractTerms, d: ContractDevice): ContractStatusCode {
  return d.status ?? c.status;
}

const billable = (s: ContractStatusCode) => s === 'ACTIVE' || s === 'EXPIRED';

// ---------------------------------------------------------------- plan

/** Razrješava plan uređaja u poredana razdoblja sa stvarnim granicama. */
export function devicePlan(c: ContractTerms, d: ContractDevice): PlanPeriod[] {
  const base = {
    from: c.firstBillingDate || c.startDate,
    billing: c.billing,
    price: d.monthly,
    season: seasonOf(c.seasonFrom, c.seasonTo),
  };

  const raw = (d.plan?.length ? d.plan : [{}])
    .map((p) => ({
      from: p.from || base.from,
      to: p.to || '',
      billing: p.billing || base.billing,
      price: p.price !== null && p.price !== undefined && !Number.isNaN(p.price) ? p.price : base.price,
      season: p.seasonFrom !== undefined && p.seasonFrom !== null ? seasonOf(p.seasonFrom, p.seasonTo) : base.season,
    }))
    .filter((p) => p.from)
    .sort((a, b) => a.from.localeCompare(b.from));

  return raw.map((p, i) => {
    let to: ISODate | '' = p.to;
    const next = raw[i + 1];
    if (next) {
      const before = addDays(next.from, -1);
      to = to && to < before ? to : before;
    }
    if (c.endDate && (!to || to > c.endDate)) to = c.endDate;
    return { ...p, to };
  })
    // razdoblje koje počinje nakon kraja ugovora (ili sljedećeg razdoblja) ne postoji
    .filter((p) => !p.to || p.to >= p.from);
}

/** Sva zaduženja uređaja u rasponu razdoblja (uključivo). */
export function deviceCharges(c: ContractTerms, d: ContractDevice, fromPeriod: Period, toPeriod: Period): Charge[] {
  if (!billable(deviceStatus(c, d))) return [];
  const out: Charge[] = [];
  for (const s of devicePlan(c, d)) {
    const step = billingMonths(s.billing);
    if (step === 0) {
      const p = s.from.slice(0, 7);
      const months = monthsBetween(s.from, s.to || null);
      if (p >= fromPeriod && p <= toPeriod && inSeason(s.season, Number(p.slice(5, 7)))) {
        out.push({ period: p, amount: r2(s.price * months), billing: s.billing, months, monthly: s.price });
      }
      continue;
    }
    const [y, m] = parts(s.from);
    for (let k = 0; k < 600; k++) {
      const start = ymd(y, m + k * step, 1);
      const p = start.slice(0, 7);
      if (s.to && start > s.to) break;
      if (p > toPeriod) break;
      if (p < fromPeriod) continue;
      if (!inSeason(s.season, Number(p.slice(5, 7)))) continue;
      out.push({ period: p, amount: r2(s.price * step), billing: s.billing, months: step, monthly: s.price });
    }
  }
  return out.sort((a, b) => a.period.localeCompare(b.period));
}

export const deviceChargesInYear = (c: ContractTerms, d: ContractDevice, year: number) =>
  deviceCharges(c, d, `${year}-01`, `${year}-12`);

/** Je li uređaj u obračunu u razdoblju (neovisno o tome kad se naplaćuje). */
export function deviceActiveIn(c: ContractTerms, d: ContractDevice, p: Period): PlanPeriod | null {
  if (!billable(deviceStatus(c, d))) return null;
  const first = periodStart(p);
  const last = ymd(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 31);
  for (const s of devicePlan(c, d)) {
    if (last < s.from) continue;
    if (s.to && first > s.to) continue;
    if (inSeason(s.season, Number(p.slice(5, 7)))) return s;
  }
  return null;
}

/** Mjesečni obračun (accrual) po mjesecima godine. */
export function contractAccrual(c: ContractTerms, devices: ContractDevice[], year: number): number[] {
  const out = Array<number>(12).fill(0);
  for (const d of devices) {
    for (let m = 0; m < 12; m++) out[m] += deviceActiveIn(c, d, mkPeriod(year, m))?.price ?? 0;
  }
  return out.map(r2);
}

/** Naplata (rate) po mjesecima godine. */
export function contractBilling(c: ContractTerms, devices: ContractDevice[], year: number): number[] {
  const out = Array<number>(12).fill(0);
  for (const d of devices) {
    for (const ch of deviceChargesInYear(c, d, year)) out[Number(ch.period.slice(5, 7)) - 1] += ch.amount;
  }
  return out.map(r2);
}

export function contractMonthly(devices: ContractDevice[]): number {
  return r2(devices.reduce((a, d) => a + d.monthly, 0));
}

/** „Mjesečno → kvartalno od 01.10.2026." */
export function planSummary(c: ContractTerms, d: ContractDevice): string {
  const plan = devicePlan(c, d);
  if (!plan.length) return '—';
  return plan
    .map((s, i) => {
      const name = BILLING_LABEL[s.billing].toLowerCase();
      if (i === 0) return name;
      const [y, m, day] = s.from.split('-');
      return `${name} od ${day}.${m}.${y}.`;
    })
    .join(' → ');
}

export const hasCustomPlan = (d: ContractDevice) => Boolean(d.plan?.length) || Boolean(d.status);

// ---------------------------------------------------------------- datumi rata

function billingDayOf(c: ContractTerms): number {
  const first = c.firstBillingDate || c.startDate;
  const d = c.billingDay || (first ? Number(first.slice(8, 10)) : 1);
  return Math.min(31, Math.max(1, d));
}

/**
 * Datum računa za razdoblje: unaprijed — u mjesecu razdoblja, unatrag — u
 * sljedećem. Prva rata ide na datum prve naplate, ostale na dan naplate.
 */
export function installmentDate(c: ContractTerms, p: Period): ISODate {
  const base = c.billingMode === 'IN_ARREARS' ? addMonths(periodStart(p), 1) : periodStart(p);
  const first = c.firstBillingDate || c.startDate;
  if (first && first.slice(0, 7) === base.slice(0, 7)) return first;
  return ymd(Number(base.slice(0, 4)), Number(base.slice(5, 7)), billingDayOf(c));
}

export interface PendingInstallment {
  period: Period;
  dueDate: ISODate;
  amount: number;
  lines: Array<Charge & { itemId: string }>;
}

/**
 * Rate koje su dospjele, a nisu fakturirane.
 *
 * Pokrivenost se vodi po UREĐAJU i razdoblju: `covered` sadrži ključeve
 * `itemId|YYYY-MM` iz izdanih (nestorniranih) računa za najam, a preskočena
 * razdoblja uređaja (`skipped`) računaju se kao pokrivena. Gleda se najviše
 * `lookbackMonths` unatrag.
 */
export function pendingInstallments(
  c: ContractTerms,
  devices: ContractDevice[],
  covered: ReadonlySet<string>,
  now: ISODate = today(),
  lookbackMonths = 24,
): PendingInstallment[] {
  if (c.status !== 'ACTIVE') return [];
  const limit = addMonths(now, -lookbackMonths);
  const from = limit.slice(0, 7);
  const to = addMonths(now, 1).slice(0, 7);
  const byPeriod = new Map<Period, PendingInstallment>();

  for (const d of devices) {
    const skipped = new Set(d.skipped ?? []);
    for (const ch of deviceCharges(c, d, from, to)) {
      const due = installmentDate(c, ch.period);
      if (due > now || due < limit) continue;
      if (skipped.has(ch.period) || covered.has(`${d.itemId}|${ch.period}`)) continue;
      const row = byPeriod.get(ch.period) ?? { period: ch.period, dueDate: due, amount: 0, lines: [] };
      row.lines.push({ ...ch, itemId: d.itemId });
      row.amount = r2(row.amount + ch.amount);
      byPeriod.set(ch.period, row);
    }
  }
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

/** Sljedeći datum naplate (od danas) — najraniji među uređajima. */
export function nextBillingDate(c: ContractTerms, devices: ContractDevice[], now: ISODate = today()): ISODate | null {
  if (c.status !== 'ACTIVE') return null;
  const from = addMonths(now, -1).slice(0, 7);
  const to = addMonths(now, 24).slice(0, 7);
  let best: ISODate | null = null;
  for (const d of devices) {
    for (const ch of deviceCharges(c, d, from, to)) {
      const due = installmentDate(c, ch.period);
      if (due >= now) {
        if (!best || due < best) best = due;
        break;
      }
    }
  }
  return best;
}

/**
 * Treba li uređaj vratiti s terena: ugovor raskinut ili istekao, prošao kraj
 * plana ili je trenutni mjesec izvan sezone. Vraća razlog ili null.
 */
export function returnReason(c: ContractTerms, d: ContractDevice, now: ISODate = today()): string | null {
  if (c.status === 'TERMINATED') return 'Ugovor raskinut';
  if (c.status === 'EXPIRED' || (c.endDate && c.endDate < now)) return 'Ugovor istekao';
  if (d.status === 'TERMINATED') return 'Uređaj raskinut na ugovoru';
  const plan = devicePlan(c, d);
  if (!plan.length) return null;
  const last = plan[plan.length - 1];
  if (last.to && last.to < now) return 'Plan naplate istekao';
  const current = plan.find((s) => s.from <= now && (!s.to || s.to >= now));
  if (current?.season && !inSeason(current.season, Number(now.slice(5, 7)))) return 'Sezona završila';
  return null;
}
