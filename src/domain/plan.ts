/**
 * Plan naplate u obrascima — pretvorba između redaka obrasca i zapisa na
 * ugovoru (ContractItem.plan), provjera plana i razdoblja koja su već prošla.
 * Čista logika: koristi je i klijent (PlanEditor) i poslužitelj (akcije).
 * Sami iznosi rata računaju se isključivo u `@/domain/billing`.
 */
import {
  BILLING_LABEL, deviceCharges, installmentDate, scheduledCharges,
  type BillingCode, type ContractDevice, type ContractTerms, type PlanPeriodInput,
} from '@/domain/billing';
import { addDays, addMonths, MONTHS_HR, type ISODate, type Period } from '@/domain/dates';
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

// ---------------------------------------------------------------- skupne izmjene uvjeta (C6)

/** Skupna sezona na uređajima: sezonski (tra–lis), cijela godina ili kao na ugovoru. */
export type BulkSeason = 'summer' | 'year' | 'contract';

export const BULK_SEASON_OPTIONS: { value: BulkSeason; label: string }[] = [
  { value: 'summer', label: 'Sezonski (tra–lis)' },
  { value: 'year', label: 'Cijela godina' },
  { value: 'contract', label: 'Kao na ugovoru' },
];

/** Sezona „ljeto" iz starog programa: travanj–listopad. */
export const SUMMER_SEASON = { from: 4, to: 10 } as const;

/**
 * Prvi dan od kojeg izmjena uvjeta naplate smije vrijediti za uređaj: nikad prije
 * tekućeg mjeseca i nikad unutar razdoblja koje je već fakturirano, izdano izvan
 * programa (`covered` + `skipped`) ili pauzirano — godišnja rata izdana u siječnju
 * pokriva cijelu godinu, pa nova mjesečna naplata kreće tek sljedeće godine, a
 * pauzirana kvartalna rata ostaje pauzirana za sva tri mjeseca.
 * Rate starih uvjeta koje počinju prije tog dana ostaju cijele (i neizdane).
 */
export function bulkCutoff(terms: ContractTerms, device: ContractDevice, covered: ReadonlySet<Period>, now: ISODate): ISODate {
  const c: ContractTerms = { ...terms, status: 'ACTIVE' };
  const d: ContractDevice = { ...device, status: null, paused: [] };
  const from = [c.startDate, c.firstBillingDate || c.startDate, ...(device.plan ?? []).map((p) => p.from || '')].filter(Boolean).sort()[0];
  const done = new Set([...covered, ...(device.skipped ?? []), ...(device.paused ?? [])]);
  const after = (m: Period) => addMonths(`${m}-01`, 1);
  const later = (a: ISODate, b: ISODate) => (a > b ? a : b);
  let cut = `${now.slice(0, 7)}-01`;
  const charges = scheduledCharges(c, d, from.slice(0, 7), addMonths(now, 120).slice(0, 7));
  const scheduled = new Set(charges.map((ch) => ch.period));
  // fakturirano razdoblje kojeg više nema u planu pokriva barem svoj mjesec
  for (const p of done) if (!scheduled.has(p)) cut = later(cut, after(p));
  for (const ch of charges) {
    // rata pokriva mjesece do zadnjeg naplaćenog (sezona, kraj razdoblja)
    if (ch.period < cut.slice(0, 7) || done.has(ch.period)) cut = later(cut, after(ch.covers[ch.covers.length - 1] ?? ch.period));
  }
  return cut;
}

/** Plan razriješen iz zapisa: početak (prazno = `base`) i stvarni kraj razdoblja (prije sljedećeg). */
function spans(plan: PlanPeriodInput[] | null | undefined, base: ISODate) {
  const start = (p: PlanPeriodInput) => p.from || base;
  const src = (plan?.length ? plan : [{ from: base }]).map((p) => ({ ...p })).sort((a, b) => start(a).localeCompare(start(b)));
  return src.map((p, i) => {
    const next = src[i + 1];
    const nextEnd = next ? addDays(start(next), -1) : '';
    const end = p.to && (!nextEnd || p.to < nextEnd) ? p.to : nextEnd;
    return { p, start: start(p), end };
  });
}

/** Zapis plana bez razdoblja koje ništa ne mijenja (jedno razdoblje od početka naplate, bez vlastitih uvjeta). */
function trimTrivial(rows: PlanPeriodInput[], base: ISODate): PlanPeriodInput[] {
  const only = rows.length === 1 ? rows[0] : null;
  const trivial =
    only &&
    (!only.from || only.from === base) &&
    !only.to &&
    (only.price === null || only.price === undefined) &&
    !only.billing &&
    (only.seasonFrom === null || only.seasonFrom === undefined);
  return trivial ? [] : rows;
}

const chargeKey = (ch: { period: Period; months: number; amount: number }) => `${ch.period}:${ch.months}:${ch.amount}`;

/**
 * Nova pravila naplate uređaja (izmjena uvjeta ugovora, plana uređaja ili skupna
 * naplata/sezona) — JEDINA provjera za sva tri puta: nova pravila vrijede tek od
 * `bulkCutoff` (prva neizdana, nepauzirana rata od tekućeg mjeseca). Razdoblja
 * prije granice ostaju po starim uvjetima (kod izmjene ugovora zapisuju se
 * izričito — naplata i sezona — jer uređaj inače nasljeđuje nove uvjete ugovora).
 * Ako se rate prije granice ne mijenjaju, novi plan vrijedi u cijelosti.
 *
 * Pauze se čuvaju: granica prelazi i pauzirane rate (vidi `bulkCutoff`), pa sva
 * pauzirana razdoblja ostaju u dijelu plana po starim uvjetima.
 *
 * @param terms dosadašnji uvjeti ugovora; `nextTerms` novi (izmjena ugovora)
 * @param device uređaj s dosadašnjim planom i pauzama
 * @param next željeni plan uređaja (za nove uvjete) kao da vrijedi od početka
 * @param covered fakturirana razdoblja uređaja (YYYY-MM)
 */
export function rebasePlan(a: {
  terms: ContractTerms;
  nextTerms?: ContractTerms;
  device: ContractDevice;
  next: PlanPeriodInput[];
  covered: ReadonlySet<Period>;
  now: ISODate;
}): { plan: PlanPeriodInput[]; cut: ISODate | null } {
  const oldT: ContractTerms = { ...a.terms, status: 'ACTIVE' };
  const newT: ContractTerms = { ...(a.nextTerms ?? a.terms), status: 'ACTIVE' };
  const oldD: ContractDevice = { ...a.device, status: null, paused: [] };
  const newD: ContractDevice = { ...oldD, plan: a.next };
  const cut = bulkCutoff(a.terms, a.device, a.covered, a.now);
  const before = (t: ContractTerms, d: ContractDevice) => scheduledCharges(t, d, '0000-01', addMonths(cut, -1).slice(0, 7)).map(chargeKey).join('|');
  const newBase = newT.firstBillingDate || newT.startDate;

  let plan: PlanPeriodInput[];
  let splitAt: ISODate | null = null;
  if (before(oldT, oldD) === before(newT, newD)) plan = a.next;
  else {
    splitAt = cut;
    const oldBase = oldT.firstBillingDate || oldT.startDate;
    const head: PlanPeriodInput[] = [];
    for (const { p, start, end } of spans(a.device.plan, oldBase)) {
      if (start >= cut) continue;
      const row: PlanPeriodInput = end && end < cut ? { ...p } : { ...p, to: addDays(cut, -1) };
      if (a.nextTerms) {
        // uvjeti ugovora se mijenjaju: staro razdoblje dobiva izričitu naplatu i sezonu dosadašnjeg ugovora
        row.from = start;
        row.billing = p.billing || oldT.billing;
        if (p.seasonFrom === null || p.seasonFrom === undefined) {
          row.seasonFrom = oldT.seasonFrom || 0;
          row.seasonTo = oldT.seasonFrom ? oldT.seasonTo || 0 : 0;
        }
      }
      head.push(row);
    }
    // novi plan od granice: razdoblja koja završavaju prije granice otpadaju, ono preko granice počinje na granici
    const tail: PlanPeriodInput[] = [];
    for (const { p, start, end } of spans(a.next, newBase)) {
      if (end && end < cut) continue;
      tail.push(start < cut ? { ...p, from: cut } : p);
    }
    plan = [...head, ...tail];
  }
  return { plan: trimTrivial(plan, newBase), cut: splitAt };
}

/**
 * Skupna izmjena naplate i/ili sezone na planu jednog uređaja. Plan bez
 * razdoblja dobiva jedno razdoblje od početka naplate ugovora (`base`).
 * Bez `from` (ili kad je `from` na početku plana) izmjena vrijedi za cijeli plan;
 * inače se plan dijeli: razdoblja prije `from` ostaju kakva jesu, a nova pravila
 * vrijede od `from` (vidi `bulkCutoff`) — prošla i fakturirana razdoblja se ne otvaraju.
 * „Kao na ugovoru" briše sezonu (a kod plana s jednim razdobljem i vlastitu
 * naplatu); razdoblje koje više ništa ne mijenja vraća uređaj na uvjete ugovora (prazan plan).
 */
export function applyBulkTerms(
  plan: PlanPeriodInput[] | null | undefined,
  base: ISODate,
  patch: { billing?: BillingCode | null; season?: BulkSeason | null },
  from?: ISODate | null,
): PlanPeriodInput[] {
  const start = (p: PlanPeriodInput) => p.from || base;
  const src = (plan?.length ? plan : [{ from: base }]).map((p) => ({ ...p })).sort((a, b) => start(a).localeCompare(start(b)));
  const cut = from && from > start(src[0]) ? from : null;
  const apply = (p: PlanPeriodInput, single: boolean) => {
    if (patch.billing) p.billing = patch.billing;
    if (patch.season === 'summer') {
      p.seasonFrom = SUMMER_SEASON.from;
      p.seasonTo = SUMMER_SEASON.to;
    } else if (patch.season === 'year') {
      p.seasonFrom = 0;
      p.seasonTo = 0;
    } else if (patch.season === 'contract') {
      delete p.seasonFrom;
      delete p.seasonTo;
      if (single && !patch.billing) delete p.billing;
    }
    return p;
  };
  if (!cut) {
    for (const p of src) apply(p, src.length === 1);
  }
  const same = (a: PlanPeriodInput, b: PlanPeriodInput) =>
    (a.billing ?? null) === (b.billing ?? null) &&
    (a.price ?? null) === (b.price ?? null) &&
    (a.seasonFrom ?? null) === (b.seasonFrom ?? null) &&
    (a.seasonTo ?? null) === (b.seasonTo ?? null);
  const rows: PlanPeriodInput[] = cut ? [] : src;
  if (cut) {
    src.forEach((p, i) => {
      const next = src[i + 1];
      const nextEnd = next ? addDays(start(next), -1) : '';
      const end = p.to && (!nextEnd || p.to < nextEnd) ? p.to : nextEnd;
      if (start(p) >= cut) rows.push(apply(p, false));
      else if (end && end < cut) rows.push(p);
      else {
        // razdoblje preko granice: staro do dana prije, novo od granice (ako se išta mijenja)
        const tail = apply({ ...p, from: cut }, false);
        if (same(tail, p)) rows.push(p);
        else rows.push({ ...p, from: start(p), to: addDays(cut, -1) }, tail);
      }
    });
  }
  const only = rows.length === 1 ? rows[0] : null;
  const trivial =
    only &&
    (!only.from || only.from === base) &&
    !only.to &&
    (only.price === null || only.price === undefined) &&
    !only.billing &&
    (only.seasonFrom === null || only.seasonFrom === undefined);
  return trivial ? [] : rows;
}
