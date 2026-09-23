/**
 * Stara baza → plan: ugovori o najmu (uređaji, cijene, uvjeti i plan naplate po
 * uređaju, preskočena razdoblja) i ručni upisi u tablicu najma.
 */
import type { Billing, BillingMode, ContractStatus } from '@prisma/client';
import type { LegacyCtx } from './legacy-ctx';
import { parseLegacyNumber, type LegacyContract } from './legacy-parse';
import type { Key, PlanContractItem } from './plan';
import type { PlanPeriodInput } from '@/domain/billing';
import { r2 } from '@/domain/money';

export const BILLING: Record<string, Billing> = { mjesecno: 'MONTHLY', kvartalno: 'QUARTERLY', polugodisnje: 'SEMIANNUAL', godisnje: 'ANNUAL', jednokratno: 'ONCE' };
export const BILLING_MODE: Record<string, BillingMode> = { unaprijed: 'IN_ADVANCE', unatrag: 'IN_ARREARS' };
export const CONTRACT_STATUS: Record<string, ContractStatus> = { aktivan: 'ACTIVE', pauziran: 'PAUSED', istekao: 'EXPIRED', raskinut: 'TERMINATED' };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

type Season = { from: number; to: number } | null | undefined;

/** Sezona iz stare baze: undefined = nije zadana (nasljeđuje), null = cijela godina, {from,to} = raspon. */
function seasonOf(ctx: LegacyCtx, v: unknown, where: string): Season {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === false) return null;
  if (isObj(v)) {
    const from = Number(v.from);
    const to = Number(v.to);
    if (Number.isInteger(from) && Number.isInteger(to) && from >= 1 && from <= 12 && to >= 1 && to <= 12) return { from, to };
    if (!v.from && !v.to) return null;
  }
  ctx.w.warn('season', 'ugovor', `${where}: nečitljiva sezona ${JSON.stringify(v)} — zanemarena.`);
  return undefined;
}

function withSeason(p: PlanPeriodInput, s: Season): PlanPeriodInput {
  if (s === undefined) return p;
  // sezona 0 = izričito cijela godina (ne nasljeđuje sezonu ugovora)
  return s === null ? { ...p, seasonFrom: 0, seasonTo: 0 } : { ...p, seasonFrom: s.from, seasonTo: s.to };
}

/**
 * Uvjeti uređaja → plan naplate. Stara verzija: `terms[itemId] = { plan: [{ from, to, billing, price, seasonal }], status }`,
 * a stariji zapisi umjesto plana imaju pojedinačna odstupanja (`billing`, `seasonal`, `startDate`…).
 */
export function planFromTerms(ctx: LegacyCtx, t: Record<string, unknown>, baseFrom: string, where: string): PlanPeriodInput[] {
  const tSeason = 'seasonal' in t ? seasonOf(ctx, t.seasonal, where) : undefined;
  const tBilling = BILLING[str(t.billing)];
  if (str(t.billing) && !tBilling) ctx.w.warn('billing', 'ugovor', `${where}: nepoznata naplata „${str(t.billing)}" — kao na ugovoru.`);
  const from0 = ctx.date(t.firstBillingDate, where, 'prva rata') ?? ctx.date(t.startDate, where, 'početak') ?? baseFrom;

  if (Array.isArray(t.plan) && t.plan.length) {
    const out: PlanPeriodInput[] = [];
    const seen = new Set<string>();
    for (const [i, raw] of t.plan.entries()) {
      if (!isObj(raw)) continue;
      const w = `${where}, razdoblje ${i + 1}`;
      const from = ctx.date(raw.from, w, 'od') ?? from0;
      if (seen.has(from)) {
        ctx.w.warn('plan-dup', 'ugovor', `${w}: dva razdoblja počinju ${from} — drugo izostavljeno.`);
        continue;
      }
      seen.add(from);
      let p: PlanPeriodInput = { from };
      const to = ctx.date(raw.to, w, 'do');
      if (to && to >= from) p.to = to;
      else if (to) ctx.w.warn('plan-to', 'ugovor', `${w}: „do" (${to}) je prije „od" (${from}) — izostavljeno.`);
      const b = BILLING[str(raw.billing)] ?? tBilling;
      if (str(raw.billing) && !BILLING[str(raw.billing)]) ctx.w.warn('billing', 'ugovor', `${w}: nepoznata naplata „${str(raw.billing)}".`);
      if (b) p.billing = b;
      const price = ctx.num(parseLegacyNumber(raw.price), w, 'cijena', null);
      if (price !== null && price >= 0) p.price = r2(price);
      p = withSeason(p, 'seasonal' in raw ? seasonOf(ctx, raw.seasonal, w) : tSeason);
      out.push(p);
    }
    return out.sort((a, b) => String(a.from).localeCompare(String(b.from)));
  }

  const endRaw = ctx.date(t.endDate, where, 'kraj');
  const custom = tBilling || tSeason !== undefined || str(t.startDate) || str(t.firstBillingDate) || endRaw;
  if (!custom) return [];
  let p: PlanPeriodInput = { from: from0 };
  if (endRaw && endRaw >= from0) p.to = endRaw;
  if (tBilling) p.billing = tBilling;
  p = withSeason(p, tSeason);
  return [p];
}

/** Ugovori; vraća mapu uređaj → ugovor (uređaj smije biti samo na jednom ugovoru). */
export function mapContracts(ctx: LegacyCtx, rows: LegacyContract[]) {
  const onContract = new Map<Key, string>();
  // aktivni ugovori prvi — ako je uređaj na dva ugovora, ostaje na aktivnom
  const ordered = [...rows.entries()].sort(([, a], [, b]) => Number(b.status === 'aktivan' || !b.status) - Number(a.status === 'aktivan' || !a.status));
  for (const [i, r] of ordered) {
    const key = r.id ?? ctx.genKey('contract');
    const where = `Ugovor ${r.number || `#${i + 1}`}`;
    if (ctx.contracts.has(key)) {
      ctx.w.warn('dup-id', 'ugovor', `${where}: id se ponavlja — drugi zapis preskočen.`);
      continue;
    }
    let partnerKey = ctx.partner(r.partnerId, where, 'najmoprimac');
    if (!partnerKey) partnerKey = ctx.customerPlaceholder();
    const startDate = ctx.reqDate(where, 'početak', r.startDate, r.createdAt);
    const status = CONTRACT_STATUS[r.status || 'aktivan'];
    if (!status) ctx.w.warn('contract-status', 'ugovor', `${where}: nepoznat status „${r.status}" — uvezen kao aktivan.`);
    const billing = BILLING[r.billing || 'mjesecno'];
    if (!billing) ctx.w.warn('billing', 'ugovor', `${where}: nepoznata naplata „${r.billing}" — mjesečno.`);
    const billingMode = BILLING_MODE[r.billingMode || 'unaprijed'];
    if (!billingMode) ctx.w.warn('billing-mode', 'ugovor', `${where}: nepoznat način naplate „${r.billingMode}" — unaprijed.`);
    const season = seasonOf(ctx, r.seasonal !== undefined && r.seasonal !== null ? r.seasonal : r.season, where);
    const firstBillingDate = ctx.date(r.firstBillingDate, where, 'prva rata');
    const endDate = ctx.date(r.endDate, where, 'kraj');
    const baseFrom = firstBillingDate ?? startDate;

    // preskočena razdoblja: 'itemId|YYYY-MM'
    const skipped = new Map<string, string[]>();
    for (const s of r.skipped) {
      const [itemId, p] = s.split('|');
      if (!itemId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(p ?? '')) {
        ctx.w.warn('skipped', 'ugovor', `${where}: nečitljivo preskočeno razdoblje „${s}".`);
        continue;
      }
      skipped.set(itemId, [...(skipped.get(itemId) ?? []), p]);
    }

    const items: PlanContractItem[] = [];
    for (const itemId of new Set(r.itemIds)) {
      const w = `${where}, uređaj ${itemId}`;
      const item = ctx.items.get(itemId);
      if (!item) {
        ctx.w.warn('ref-item', 'veza', `${where}: uređaj „${itemId}" ne postoji — izostavljen s ugovora.`);
        continue;
      }
      const iw = `${where}, SN ${item.serial}`;
      if (onContract.has(item.key)) {
        ctx.w.warn('contract-item-dup', 'ugovor', `${iw}: uređaj je već na ugovoru ${onContract.get(item.key)} — ovdje izostavljen.`);
        continue;
      }
      if (item.state !== 'RENTED' && item.state !== 'RETURNING') {
        ctx.w.warn('contract-item-state', 'ugovor', `${iw}: status uređaja nije „u najmu" ni „u dolasku" — ne ostaje na ugovoru (pravilo nove verzije).`);
        continue;
      }
      let monthly = ctx.money(parseLegacyNumber((r.prices as Record<string, unknown>)[itemId]), iw, 'mjesečna cijena', null);
      if (monthly === null) {
        monthly = item.rentPrice ?? r2(item.cost * 0.055);
        ctx.w.info('contract-price', 'ugovor', `${iw}: nema mjesečne cijene — upisano ${monthly.toFixed(2)} (cijena najma uređaja ili 5,5 % nabavne).`);
      }
      const t = isObj(r.terms[itemId]) ? (r.terms[itemId] as Record<string, unknown>) : {};
      const devStatus = str(t.status) ? CONTRACT_STATUS[str(t.status)] ?? null : null;
      if (str(t.status) && !devStatus) ctx.w.warn('contract-status', 'ugovor', `${iw}: nepoznat status uređaja „${str(t.status)}".`);
      items.push({
        itemKey: item.key,
        monthly,
        plan: planFromTerms(ctx, t, baseFrom, iw),
        status: devStatus,
        skipped: [...new Set(skipped.get(itemId) ?? [])].sort(),
      });
      skipped.delete(itemId);
      onContract.set(item.key, r.number || key);
      if (item.partnerKey !== partnerKey) {
        if (item.partnerKey) ctx.w.info('contract-partner', 'ugovor', `${iw}: kupac na uređaju razlikuje se od najmoprimca — preuzet najmoprimac.`);
        item.partnerKey = partnerKey;
      }
    }
    for (const [itemId] of skipped) ctx.w.info('skipped-orphan', 'ugovor', `${where}: preskočena razdoblja za uređaj „${itemId}" koji nije na ugovoru — izostavljena.`);

    const number = r.number ? ctx.numbers.unique('CONTRACT', r.number) : ctx.numbers.next('CONTRACT', Number(startDate.slice(0, 4)));
    if (r.number && number !== r.number) ctx.w.warn('dup-number', 'ugovor', `${where}: broj se ponavlja — uvezen kao „${number}".`);
    ctx.contracts.add(key);
    ctx.plan.contracts.push({
      key,
      number,
      generatedNumber: !r.number,
      partnerKey,
      status: status ?? 'ACTIVE',
      startDate,
      endDate: endDate && endDate >= startDate ? endDate : null,
      firstBillingDate,
      billingDay: ctx.int(r.billingDay, where, 'dan naplate', 1, 31),
      billing: billing ?? 'MONTHLY',
      billingMode: billingMode ?? 'IN_ADVANCE',
      seasonFrom: season ? season.from : null,
      seasonTo: season ? season.to : null,
      terminatedAt: ctx.date(r.terminatedAt, where, 'raskinut'),
      note: r.note || null,
      createdBy: ctx.user(r.createdBy),
      createdAt: ctx.ts(r.createdAt),
      items,
    });
  }
}

/** Ručni upisi u tablicu najma: rent[itemId][godina][mjesec 0–11] = iznos (null = automatski). */
export function mapRent(ctx: LegacyCtx, rent: unknown) {
  if (!isObj(rent)) return;
  for (const [itemId, years] of Object.entries(rent)) {
    const item = ctx.items.get(itemId);
    if (!item) {
      ctx.w.warn('ref-item', 'veza', `Tablica najma: uređaj „${itemId}" ne postoji — upisi izostavljeni.`);
      continue;
    }
    if (!isObj(years)) continue;
    for (const [y, months] of Object.entries(years)) {
      const year = Number(y);
      if (!Number.isInteger(year) || year < 1990 || year > 2200) {
        ctx.w.warn('rent-year', 'najam', `Tablica najma, SN ${item.serial}: nečitljiva godina „${y}".`);
        continue;
      }
      const cells: Array<[string, unknown]> = Array.isArray(months) ? months.map((v, i) => [String(i), v]) : isObj(months) ? Object.entries(months) : [];
      for (const [m, raw] of cells) {
        const v = isObj(raw) ? raw.value : raw;
        if (v === null || v === undefined || v === '') continue; // prazno = izračun
        const month = Number(m);
        const amount = ctx.money(parseLegacyNumber(v), `Tablica najma, SN ${item.serial}, ${y}/${Number(m) + 1}`, 'iznos', null);
        if (amount === null || !Number.isInteger(month) || month < 0 || month > 11) continue;
        ctx.plan.rentOverrides.push({ itemKey: item.key, year, month: month + 1, amount });
      }
    }
  }
}
