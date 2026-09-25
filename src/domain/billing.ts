import { addDays, addMonths, monthsBetween, parts, period as mkPeriod, periodEnd, periodStart, today, ymd, type ISODate, type Period } from './dates';
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
  // rata dospijeva mjesec nakon početka razdoblja (kod mjesečne naplate = po isteku mjeseca)
  IN_ARREARS: 'Unatrag — mjesec nakon početka razdoblja',
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
  /**
   * Datum kad je ugovor raskinut ili označen kao istekao u programu. Tada se
   * rate do kraja ugovora koje još nisu izdane i dalje traže (naplata unatrag,
   * zaostale rate). Uvezeni zatvoreni ugovori ga nemaju — za njih se ne traži ništa.
   */
  closedAt?: ISODate | null;
  /**
   * Početak pauze ugovora (status PAUSED). Rate čija je odluka o naplati prije
   * pauze (vidi `pauseDecisionDate`) i dalje se traže; stara pauza bez datuma — ništa.
   */
  pausedSince?: ISODate | null;
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
  /** Pauzirana razdoblja: rata se ne naplaćuje (za razliku od `skipped` = izdano izvan programa). */
  paused?: Period[] | null;
  /** Uređaj skinut s ugovora: zadnji dan u najmu (naplata staje s tim datumom). */
  endDate?: ISODate | null;
  /** Početak pauze uređaja (status PAUSED) — rate prije pauze i dalje se traže. */
  pausedSince?: ISODate | null;
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
  /**
   * Broj mjeseci koje rata naplaćuje: mjeseci razdoblja rate unutar sezone i do
   * kraja razdoblja plana (kraj ugovora, skidanje uređaja) — kvartal sa samo
   * jednim sezonskim mjesecom naplaćuje jedan mjesec.
   */
  months: number;
  /** Mjeseci koje rata naplaćuje (YYYY-MM, uzlazno; `months` = njihov broj). */
  covers: Period[];
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

/**
 * Stvara li uređaj rate: aktivan i istekao da; pauziran ne; raskinut ugovor samo
 * ako je raskinut u programu i ima kraj (rate do kraja), raskinut uređaj ne.
 */
function billable(c: ContractTerms, d: ContractDevice): boolean {
  const s = deviceStatus(c, d);
  if (s === 'ACTIVE' || s === 'EXPIRED') return true;
  return s === 'TERMINATED' && !d.status && Boolean(c.closedAt && c.endDate);
}

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
    if (d.endDate && (!to || to > d.endDate)) to = d.endDate;
    return { ...p, to };
  })
    // razdoblje koje počinje nakon kraja ugovora (ili sljedećeg razdoblja) ne postoji
    .filter((p) => !p.to || p.to >= p.from);
}

/** Sva zaduženja uređaja u rasponu razdoblja (uključivo), bez pauziranih razdoblja. */
export function deviceCharges(c: ContractTerms, d: ContractDevice, fromPeriod: Period, toPeriod: Period): Charge[] {
  const all = scheduledCharges(c, d, fromPeriod, toPeriod);
  if (!d.paused?.length) return all;
  const paused = new Set(d.paused);
  return all.filter((ch) => !paused.has(ch.period));
}

/**
 * Mjeseci koje rata razdoblja plana `s` s početkom `p` naplaćuje: od `p` kroz
 * `span` mjeseci, ali ne nakon kraja razdoblja plana i samo mjeseci u sezoni.
 */
function coveredMonths(s: PlanPeriod, p: Period, span: number): Period[] {
  const end = s.to ? s.to.slice(0, 7) : '';
  const out: Period[] = [];
  for (let k = 0; k < Math.max(1, span); k++) {
    const m = k ? addMonths(`${p}-01`, k).slice(0, 7) : p;
    if (end && m > end) break;
    if (inSeason(s.season, Number(m.slice(5, 7)))) out.push(m);
  }
  return out;
}

/**
 * Zaduženja prema planu, uključujući pauzirana (za prikaz rasporeda i provjeru pauze).
 * Rata se računa samo za mjesece koje stvarno pokriva (`coveredMonths`): sezona
 * unutar kvartala/polugodišta/godine i kraj ugovora ili skidanje uređaja usred
 * razdoblja razmjerno smanjuju ratu; razdoblje bez takvih mjeseci nema ratu.
 */
export function scheduledCharges(c: ContractTerms, d: ContractDevice, fromPeriod: Period, toPeriod: Period): Charge[] {
  if (!billable(c, d)) return [];
  const out: Charge[] = [];
  const push = (s: PlanPeriod, p: Period, covers: Period[]) => {
    if (covers.length) out.push({ period: p, amount: r2(s.price * covers.length), billing: s.billing, months: covers.length, covers, monthly: s.price });
  };
  for (const s of devicePlan(c, d)) {
    const step = billingMonths(s.billing);
    if (step === 0) {
      // jednokratno: jedna rata za cijelo razdoblje (bez kraja = jedan mjesec)
      const p = s.from.slice(0, 7);
      if (p >= fromPeriod && p <= toPeriod) push(s, p, coveredMonths(s, p, monthsBetween(s.from, s.to || null)));
      continue;
    }
    const [y, m] = parts(s.from);
    // razdoblja prije `fromPeriod` se preskaču izravno (ista razdoblja kao korak po korak)
    const behind = Number(fromPeriod.slice(0, 4)) * 12 + Number(fromPeriod.slice(5, 7)) - (y * 12 + m);
    for (let k = behind > 0 ? Math.ceil(behind / step) : 0; k < 600; k++) {
      const start = ymd(y, m + k * step, 1);
      const p = start.slice(0, 7);
      if (s.to && start > s.to) break;
      if (p > toPeriod) break;
      if (p < fromPeriod) continue;
      push(s, p, coveredMonths(s, p, step));
    }
  }
  return out.sort((a, b) => a.period.localeCompare(b.period));
}

export const deviceChargesInYear = (c: ContractTerms, d: ContractDevice, year: number) =>
  deviceCharges(c, d, `${year}-01`, `${year}-12`);

/** Je li uređaj u obračunu u razdoblju (neovisno o tome kad se naplaćuje). */
export function deviceActiveIn(c: ContractTerms, d: ContractDevice, p: Period): PlanPeriod | null {
  if (!billable(c, d)) return null;
  const first = periodStart(p);
  const last = ymd(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 31);
  for (const s of devicePlan(c, d)) {
    if (last < s.from) continue;
    // jednokratno bez kraja naplaćuje (i obračunava) samo svoj prvi mjesec
    const to = s.to || (s.billing === 'ONCE' ? periodEnd(s.from.slice(0, 7)) : '');
    if (to && first > to) continue;
    if (inSeason(s.season, Number(p.slice(5, 7)))) return s;
  }
  return null;
}

/**
 * Uvjeti i uređaj za prikaz povijesti (raspored, pregled najma, obračun): pauza
 * ugovora ili uređaja s poznatim početkom vrijedi tek od tog dana — rate i obračun
 * prije pauze ostaju vidljivi (kao u „Rate za izdati"). Stara pauza bez datuma: ništa.
 */
export function historyBasis(c: ContractTerms, d: ContractDevice): { terms: ContractTerms; device: ContractDevice; pausedAt: ISODate | null } {
  const cp = c.status === 'PAUSED' && c.pausedSince ? c.pausedSince : null;
  const dp = d.status === 'PAUSED' && d.pausedSince ? d.pausedSince : null;
  return {
    terms: cp ? { ...c, status: 'ACTIVE' } : c,
    device: dp ? { ...d, status: null } : d,
    pausedAt: [cp, dp].filter((x): x is ISODate => !!x).sort()[0] ?? null,
  };
}

/**
 * Zaduženja za prikaz povijesti (uključujući pauzirana razdoblja iz `paused`):
 * kod pauziranog ugovora/uređaja samo rate odlučene prije početka pauze.
 */
export function historyCharges(c: ContractTerms, d: ContractDevice, fromPeriod: Period, toPeriod: Period): Charge[] {
  const h = historyBasis(c, d);
  const all = scheduledCharges(h.terms, h.device, fromPeriod, toPeriod);
  const at = h.pausedAt;
  return at ? all.filter((ch) => pauseDecisionDate(h.terms, ch.period) < at) : all;
}

/** Mjesečni obračun (accrual) po mjesecima godine; pauza s poznatim početkom vrijedi od tog dana. */
export function contractAccrual(c: ContractTerms, devices: ContractDevice[], year: number): number[] {
  const out = Array<number>(12).fill(0);
  for (const d0 of devices) {
    const { terms, device: d, pausedAt } = historyBasis(c, d0);
    const paused = pausedMonths(terms, d, year);
    for (let m = 0; m < 12; m++) {
      const p = mkPeriod(year, m);
      if (paused.has(p) || (pausedAt && periodStart(p) >= pausedAt)) continue;
      out[m] += deviceActiveIn(terms, d, p)?.price ?? 0;
    }
  }
  return out.map(r2);
}

/** Mjeseci koje pokrivaju pauzirane rate (kvartalna rata pokriva tri mjeseca). */
export function pausedMonths(c: ContractTerms, d: ContractDevice, year: number): Set<Period> {
  const out = new Set<Period>();
  if (!d.paused?.length) return out;
  const paused = new Set(d.paused);
  for (const ch of scheduledCharges(c, d, `${year - 1}-01`, `${year}-12`)) {
    if (!paused.has(ch.period)) continue;
    for (const m of ch.covers) out.add(m);
  }
  return out;
}

/** Naplata (rate) po mjesecima godine; pauza s poznatim početkom vrijedi od tog dana. */
export function contractBilling(c: ContractTerms, devices: ContractDevice[], year: number): number[] {
  const out = Array<number>(12).fill(0);
  for (const d of devices) {
    const paused = new Set(d.paused ?? []);
    for (const ch of historyCharges(c, d, `${year}-01`, `${year}-12`)) if (!paused.has(ch.period)) out[Number(ch.period.slice(5, 7)) - 1] += ch.amount;
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

// skup razdoblja po nizu — uređaji učitani zajedno dijele isti niz preskočenih razdoblja
const periodSets = new WeakMap<readonly Period[], ReadonlySet<Period>>();
const NO_PERIODS: ReadonlySet<Period> = new Set();
function periodSet(list: Period[] | null | undefined): ReadonlySet<Period> {
  if (!list?.length) return NO_PERIODS;
  let set = periodSets.get(list);
  if (!set) periodSets.set(list, (set = new Set(list)));
  return set;
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
  // pauziran ugovor traži samo rate odlučene prije pauze; zatvoren (raskinut/istekao u programu) zaostale do kraja
  if (c.status === 'PAUSED' && !c.pausedSince) return [];
  if (c.status !== 'ACTIVE' && c.status !== 'PAUSED' && !(c.closedAt && c.endDate)) return [];
  const terms: ContractTerms = c.status === 'PAUSED' ? { ...c, status: 'ACTIVE' } : c;
  const limit = addMonths(now, -lookbackMonths);
  const from = limit.slice(0, 7);
  const to = addMonths(now, 1).slice(0, 7);
  const byPeriod = new Map<Period, PendingInstallment>();
  // isti uređaj može biti i na ugovoru i među skinutima (vraćen pa ponovno dodan) — rata jednom
  const seen = new Set<string>();
  // uređaji s istim uvjetima (cijena, plan, status, pauze, kraj) imaju iste rate — računaju se jednom
  const memo = new Map<string, Array<{ ch: Charge; due: ISODate }>>();

  for (const d0 of devices) {
    // pauziran uređaj s poznatim početkom pauze: rate prije pauze ostaju za izdati
    const devicePause = d0.status === 'PAUSED' && d0.pausedSince ? d0.pausedSince : null;
    const key0 = JSON.stringify([d0.monthly, d0.plan ?? null, d0.status ?? null, devicePause, d0.endDate ?? null, d0.paused ?? null]);
    let due = memo.get(key0);
    if (!due) {
      const d = devicePause ? { ...d0, status: null } : d0;
      const pausedAt = [c.status === 'PAUSED' ? c.pausedSince : null, devicePause].filter((x): x is ISODate => !!x).sort()[0] ?? null;
      due = [];
      for (const ch of deviceCharges(terms, d, from, to)) {
        const at = installmentDate(terms, ch.period);
        if (at > now || at < limit) continue;
        if (pausedAt && pauseDecisionDate(terms, ch.period) >= pausedAt) continue;
        due.push({ ch, due: at });
      }
      memo.set(key0, due);
    }
    if (!due.length) continue;
    const skipped = periodSet(d0.skipped);
    for (const { ch, due: at } of due) {
      if (skipped.has(ch.period)) continue;
      const key = `${d0.itemId}|${ch.period}`;
      if (covered.has(key) || seen.has(key)) continue;
      seen.add(key);
      const row = byPeriod.get(ch.period) ?? { period: ch.period, dueDate: at, amount: 0, lines: [] };
      row.lines.push({ ...ch, itemId: d0.itemId });
      row.amount = r2(row.amount + ch.amount);
      byPeriod.set(ch.period, row);
    }
  }
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Dan koji odlučuje pada li rata u pauzu: kod naplate unaprijed datum rate, a kod
 * naplate unatrag početak razdoblja koje rata pokriva (usluga pružena prije pauze
 * naplaćuje se i kad rata dospije u pauzi).
 */
export function pauseDecisionDate(c: ContractTerms, p: Period): ISODate {
  return c.billingMode === 'IN_ARREARS' ? periodStart(p) : installmentDate(c, p);
}

/**
 * Razdoblja čija je rata pala u pauzu [since, until): kod naplate unaprijed
 * odlučuje datum rate, a kod naplate unatrag početak razdoblja koje rata pokriva
 * (usluga pružena prije pauze naplaćuje se i kad rata dospije u pauzi).
 * Pri nastavku se ta razdoblja upisuju u `paused` uređaja — inače bi se nakon
 * nastavka sve rate iz pauze naknadno tražile.
 */
export function periodsInPause(c: ContractTerms, d: ContractDevice, since: ISODate, until: ISODate): Period[] {
  if (!since || until <= since) return [];
  const terms: ContractTerms = { ...c, status: 'ACTIVE' };
  const dev: ContractDevice = { ...d, status: null, paused: [] };
  const out: Period[] = [];
  for (const ch of scheduledCharges(terms, dev, addMonths(since, -1).slice(0, 7), until.slice(0, 7))) {
    const at = pauseDecisionDate(terms, ch.period);
    if (at >= since && at < until) out.push(ch.period);
  }
  return [...new Set(out)].sort();
}

/**
 * Sljedeći datum naplate (od danas) — najraniji među uređajima. Rate koje su već
 * fakturirane (`covered`: `itemId|YYYY-MM`) ili izdane izvan programa (`skipped`)
 * se preskaču: nakon izdane rate sljedeća je prva NEIZDANA.
 */
export function nextBillingDate(c: ContractTerms, devices: ContractDevice[], now: ISODate = today(), covered?: ReadonlySet<string>): ISODate | null {
  if (c.status !== 'ACTIVE') return null;
  const from = addMonths(now, -1).slice(0, 7);
  const to = addMonths(now, 24).slice(0, 7);
  let best: ISODate | null = null;
  for (const d of devices) {
    const skipped = new Set(d.skipped ?? []);
    for (const ch of deviceCharges(c, d, from, to)) {
      if (skipped.has(ch.period) || covered?.has(`${d.itemId}|${ch.period}`)) continue;
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

/**
 * Višak fakturiranja nakon kraja ugovora (ili skidanja): fakturirane rate
 * (`covered`: `itemId|YYYY-MM`) koje po dosadašnjim uvjetima pokrivaju mjesece
 * nakon `end` — npr. godišnja rata izdana u siječnju, a ugovor završava u lipnju.
 * Za taj iznos klijentu treba izdati odobrenje. Mjesec kraja je naplaćen cijeli.
 */
export function overbilledAfter(c: ContractTerms, devices: ContractDevice[], covered: ReadonlySet<string>, end: ISODate): { months: number; amount: number } {
  const last = end.slice(0, 7);
  // dosadašnji uvjeti (po kojima su rate fakturirane), bez statusa
  const terms: ContractTerms = { ...c, status: 'ACTIVE' };
  let months = 0;
  let amount = 0;
  for (const d of devices) {
    const dev: ContractDevice = { ...d, status: null, paused: [] };
    for (const ch of scheduledCharges(terms, dev, addMonths(end, -24).slice(0, 7), addMonths(end, 24).slice(0, 7))) {
      if (!covered.has(`${d.itemId}|${ch.period}`)) continue;
      const after = ch.covers.filter((m) => m > last).length;
      months += after;
      amount += ch.monthly * after;
    }
  }
  return { months, amount: r2(amount) };
}
