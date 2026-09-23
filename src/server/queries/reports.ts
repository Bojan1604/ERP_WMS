import 'server-only';
import { today } from '@/domain/dates';
import { salesReports } from './reports/sales';
import { receivableReports } from './reports/receivables';
import { stockReports } from './reports/stock';
import { rentReports } from './reports/rent';
import { costReports } from './reports/costs';
import { autoTotals, type ReportDef, type ReportFilters, type ReportResult } from './reports/types';

export type { ReportDef, ReportFilters, ReportResult, Col, Row, ReportChart } from './reports/types';

/** Svi izvještaji, redom kojim se prikazuju u popisu. */
export const REPORTS: ReportDef[] = [...salesReports, ...receivableReports, ...rentReports, ...stockReports, ...costReports];

export const REPORT_AREAS = ['Prodaja', 'Naplata', 'Najam', 'Nabava', 'Skladište', 'Servis', 'Troškovi'] as const;

export const findReport = (slug: string) => REPORTS.find((r) => r.slug === slug) ?? null;

type Params = Record<string, string | string[] | undefined>;
const s = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Filtri iz URL-a (?godina=2026&partner=…&kategorija=…&model=…&dana=90). */
export function readFilters(def: ReportDef, params: Params): ReportFilters {
  const now = Number(today().slice(0, 4));
  const y = Number(s(params.godina));
  const d = Number(s(params.dana));
  return {
    year: Number.isInteger(y) && y > 2000 && y <= now + 1 ? y : now,
    partnerId: def.filters.includes('partner') ? s(params.partner) : null,
    categoryId: def.filters.includes('category') ? s(params.kategorija) : null,
    modelId: def.filters.includes('model') ? s(params.model) : null,
    days: Number.isInteger(d) && d > 0 && d <= 3650 ? d : (def.defaultDays ?? 30),
  };
}

/** Pokreće izvještaj i dopunjuje redak ukupno. */
export async function runReport(def: ReportDef, companyId: string, f: ReportFilters): Promise<ReportResult> {
  const res = await def.run(companyId, f);
  const totals = res.totals === undefined ? autoTotals(res.columns, res.rows) : res.totals;
  return { ...res, totals };
}
