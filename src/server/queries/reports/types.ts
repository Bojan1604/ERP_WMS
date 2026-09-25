import { Prisma } from '@prisma/client';
import { MONTHS_HR, MONTHS_SHORT } from '@/domain/dates';
import { num } from '@/domain/money';

export type ColKind = 'text' | 'money' | 'int' | 'pct' | 'date' | 'days' | 'mono';
export type Cell = string | number | null;

export interface Col {
  key: string;
  label: string;
  kind?: ColKind;
  /** Zbroj u retku ukupno (zadano za novac i cijele brojeve). */
  sum?: boolean;
  /** Nabavna cijena, marža ili profit — skriva se bez prava „costs" (ekran i izvoz). */
  cost?: boolean;
}

export type Row = Record<string, Cell> & { _href?: string | null; _muted?: string | number | null };

export type ReportChart =
  | { kind: 'bar'; data: Array<{ label: string; title?: string; values: Record<string, number> }>; series: Array<{ key: string; label: string }>; stacked?: boolean; unit?: 'money' | 'int' }
  | { kind: 'hbar'; rows: Array<{ label: string; value: number; href?: string }>; unit?: 'money' | 'int'; title?: string };

export interface ReportResult {
  columns: Col[];
  rows: Row[];
  /** Redak ukupno; bez njega se zbrajaju stupci s `sum`. */
  totals?: Row | null;
  chart?: ReportChart;
  /** Graf prikazuje nabavne vrijednosti/profit — skriva se bez prava „costs". */
  chartCost?: boolean;
  note?: string;
}

/**
 * Filtri izvještaja (u URL-u): godina (ili „Sve"), raspon od/do, i višestruki
 * odabir partnera, kategorija, modela, statusa, skladišta, dobavljača i vrste
 * (prodaja/najam). Izvještaj navodi koje filtre razumije.
 */
export type FilterKey = 'year' | 'range' | 'partner' | 'category' | 'model' | 'status' | 'warehouse' | 'supplier' | 'type' | 'days';

export type SaleRent = 'SALE' | 'RENT';

export interface ReportFilters {
  /** null = sve godine („Sve"). */
  year: number | null;
  /** Godina za naslove i grafove po mjesecima (tekuća kad je odabrano „Sve"). */
  displayYear: number;
  from: string | null;
  to: string | null;
  partnerIds: string[];
  categoryIds: string[];
  modelIds: string[];
  statusIds: string[];
  warehouseIds: string[];
  supplierIds: string[];
  types: SaleRent[];
  days: number;
}

export interface ReportContext {
  /** Korisnik vidi nabavne cijene, maržu i profit (pravo „costs"). */
  canSeeCost: boolean;
}

export interface ReportDef {
  slug: string;
  title: string;
  area: string;
  description: string;
  filters: FilterKey[];
  /** Zadani broj dana za filtar „days". */
  defaultDays?: number;
  /** Godina „Sve" nije moguća (npr. ponavljajući troškovi se šire po godini). */
  singleYear?: boolean;
  /** Izvještaj je cijeli o nabavnim cijenama / marži — bez prava „costs" se ne prikazuje. */
  requiresCost?: boolean;
  run: (companyId: string, f: ReportFilters, ctx: ReportContext) => Promise<ReportResult>;
}

// ---------------------------------------------------------------- pomoćne

export const n = (v: Prisma.Decimal | number | bigint | null | undefined) => (typeof v === 'bigint' ? Number(v) : num(v as Prisma.Decimal | number | null));
export const margin = (rev: number, cost: number) => (rev ? ((rev - cost) / rev) * 100 : null);
export const r2 = (v: number) => Math.round(v * 100) / 100;
export const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Dvanaest redaka po mjesecima — za izvještaje „po mjesecima". */
export function monthRows(_year: number | null, fill: (m: number) => Record<string, Cell>): Row[] {
  return MONTHS_HR.map((name, i) => ({ month: `${name[0].toUpperCase()}${name.slice(1)}`, ...fill(i + 1) }));
}

export function monthChart(year: number | null, rows: Row[], series: Array<{ key: string; label: string }>, opts: { stacked?: boolean; unit?: 'money' | 'int' } = {}): ReportChart {
  return {
    kind: 'bar',
    stacked: opts.stacked,
    unit: opts.unit,
    series,
    data: rows.slice(0, 12).map((r, i) => ({
      label: MONTHS_SHORT[i],
      title: year ? `${MONTHS_HR[i]} ${year}.` : `${MONTHS_HR[i]} (sve godine)`,
      values: Object.fromEntries(series.map((s) => [s.key, Number(r[s.key] ?? 0)])),
    })),
  };
}

/** Zbroj stupaca sa `sum` (novac i cijeli brojevi zbrajaju se sami). */
export function autoTotals(columns: Col[], rows: Row[]): Row | null {
  if (!rows.length) return null;
  const out: Row = {};
  let any = false;
  for (const c of columns) {
    const summable = c.sum ?? (c.kind === 'money' || c.kind === 'int');
    if (!summable) continue;
    any = true;
    out[c.key] = Math.round(rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0) * 100) / 100;
  }
  return any ? out : null;
}

/** SQL uvjet za prihod: izdani računi, storna i odobrenja, bez isključenih partnera. */
export const revenueSql = (companyId: string) =>
  Prisma.sql`i."companyId" = ${companyId} AND i."status" = 'ISSUED' AND i."kind" IN ('INVOICE','STORNO','CREDIT_NOTE') AND p."excluded" = false
    AND NOT (i."kind" = 'STORNO' AND EXISTS (SELECT 1 FROM "Invoice" r WHERE r.id = i."refInvoiceId" AND r."kind" = 'ADVANCE'))`;

/**
 * Važeće prodajne stavke uređaja: izdani, nestornirani računi; vrsta stavke je
 * prodaja (na miješanom računu stavka nosi vlastitu vrstu). Traži aliase i, l, p.
 */
export const saleLineSql = (companyId: string) =>
  Prisma.sql`i."companyId" = ${companyId} AND i."status" = 'ISSUED' AND i."kind" = 'INVOICE' AND COALESCE(l."lineType", i."type") = 'SALE' AND i."stornoed" = false AND p."excluded" = false`;

/** Važeće stavke najma (rate): kao prodajne, ali vrsta stavke je najam. */
export const rentLineSql = (companyId: string) =>
  Prisma.sql`i."companyId" = ${companyId} AND i."status" = 'ISSUED' AND i."kind" = 'INVOICE' AND COALESCE(l."lineType", i."type") = 'RENT' AND i."stornoed" = false AND p."excluded" = false`;

export const opt = (cond: boolean, sql: Prisma.Sql) => (cond ? sql : Prisma.empty);

/** `AND stupac IN (…)` — prazan popis = bez uvjeta. `col` je interni SQL (alias.stupac), nikad ulaz korisnika. */
export const inIds = (col: string, ids: readonly string[]) => (ids.length ? Prisma.sql`AND ${Prisma.raw(col)} IN (${Prisma.join(ids)})` : Prisma.empty);

/** Granice razdoblja: presjek godine i raspona od/do (YYYY-MM-DD ili null). */
export function periodBounds(f: Pick<ReportFilters, 'year' | 'from' | 'to'>): { from: string | null; to: string | null } {
  let from = f.year ? `${f.year}-01-01` : null;
  let to = f.year ? `${f.year}-12-31` : null;
  if (f.from && (!from || f.from > from)) from = f.from;
  if (f.to && (!to || f.to < to)) to = f.to;
  return { from, to };
}

/** `AND stupac BETWEEN …` za datumski stupac prema godini i rasponu (indeks na (companyId, datum) ostaje upotrebljiv). */
export function periodSql(col: string, f: Pick<ReportFilters, 'year' | 'from' | 'to'>) {
  const { from, to } = periodBounds(f);
  const c = Prisma.raw(col);
  return Prisma.sql`${from ? Prisma.sql`AND ${c} >= ${from}::date` : Prisma.empty} ${to ? Prisma.sql`AND ${c} <= ${to}::date` : Prisma.empty}`;
}

/** Vrsta računa (prodaja/najam) — na stupcu vrste (npr. `COALESCE(l."lineType", i."type")`). */
export const typeSql = (col: string, f: Pick<ReportFilters, 'types'>) =>
  f.types.length ? Prisma.sql`AND (${Prisma.raw(col)})::text IN (${Prisma.join(f.types)})` : Prisma.empty;

/**
 * Filtri uređaja: kategorija (po komadu, inače modela), model, status, skladište,
 * dobavljač i partner kod kojeg je uređaj. Traži aliase uređaja i modela.
 */
export function itemFilterSql(f: ReportFilters, a: { item?: string; model?: string; partner?: boolean } = {}) {
  const it = a.item ?? 'it';
  const m = a.model ?? 'm';
  const cat = f.categoryIds.length
    ? Prisma.sql`AND COALESCE(${Prisma.raw(`${it}."categoryId"`)}, ${Prisma.raw(`${m}."categoryId"`)}) IN (${Prisma.join(f.categoryIds)})`
    : Prisma.empty;
  return Prisma.sql`${cat} ${inIds(`${it}."modelId"`, f.modelIds)} ${inIds(`${it}."statusId"`, f.statusIds)} ${inIds(`${it}."warehouseId"`, f.warehouseIds)} ${inIds(`${it}."supplierId"`, f.supplierIds)} ${a.partner === false ? Prisma.empty : inIds(`${it}."partnerId"`, f.partnerIds)}`;
}

/** Filtri modela (stavke bez konkretnog uređaja): kategorija i model. */
export const modelFilterSql = (f: ReportFilters, m = 'm') => Prisma.sql`${inIds(`${m}."categoryId"`, f.categoryIds)} ${inIds(`${m}.id`, f.modelIds)}`;

/** Oznaka razdoblja za naslove („2026." / „sve godine" / „1. 3. 2026. – 31. 5. 2026."). */
export function periodLabel(f: Pick<ReportFilters, 'year' | 'from' | 'to'>): string {
  const { from, to } = periodBounds(f);
  const d = (s: string) => `${Number(s.slice(8, 10))}. ${Number(s.slice(5, 7))}. ${s.slice(0, 4)}.`;
  if (f.from || f.to) return `${from ? d(from) : 'početak'} – ${to ? d(to) : 'danas'}`;
  return f.year ? `${f.year}.` : 'sve godine';
}
