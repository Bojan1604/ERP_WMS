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
  note?: string;
}

export type FilterKey = 'year' | 'partner' | 'category' | 'model' | 'days';

export interface ReportFilters {
  year: number;
  partnerId: string | null;
  categoryId: string | null;
  modelId: string | null;
  days: number;
}

export interface ReportDef {
  slug: string;
  title: string;
  area: string;
  description: string;
  filters: FilterKey[];
  /** Zadani broj dana za filtar „days". */
  defaultDays?: number;
  run: (companyId: string, f: ReportFilters) => Promise<ReportResult>;
}

// ---------------------------------------------------------------- pomoćne

export const n = (v: Prisma.Decimal | number | bigint | null | undefined) => (typeof v === 'bigint' ? Number(v) : num(v as Prisma.Decimal | number | null));
export const margin = (rev: number, cost: number) => (rev ? ((rev - cost) / rev) * 100 : null);

/** Dvanaest redaka po mjesecima — za izvještaje „po mjesecima". */
export function monthRows(year: number, fill: (m: number) => Record<string, Cell>): Row[] {
  return MONTHS_HR.map((name, i) => ({ month: `${name[0].toUpperCase()}${name.slice(1)}`, ...fill(i + 1) }));
}

export function monthChart(year: number, rows: Row[], series: Array<{ key: string; label: string }>, opts: { stacked?: boolean } = {}): ReportChart {
  return {
    kind: 'bar',
    stacked: opts.stacked,
    series,
    data: rows.slice(0, 12).map((r, i) => ({
      label: MONTHS_SHORT[i],
      title: `${MONTHS_HR[i]} ${year}.`,
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

/** Važeće prodajne stavke uređaja: izdani, nestornirani računi prodaje. */
export const saleLineSql = (companyId: string) =>
  Prisma.sql`i."companyId" = ${companyId} AND i."status" = 'ISSUED' AND i."kind" = 'INVOICE' AND i."type" = 'SALE' AND i."stornoed" = false AND p."excluded" = false`;

export const opt = (cond: boolean, sql: Prisma.Sql) => (cond ? sql : Prisma.empty);
