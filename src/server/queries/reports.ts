import 'server-only';
import { today } from '@/domain/dates';
import { parseDateRange, parseMulti, paramStr, type SearchParams } from '@/lib/list-params';
import { salesReports } from './reports/sales';
import { receivableReports } from './reports/receivables';
import { stockReports } from './reports/stock';
import { rentReports } from './reports/rent';
import { costReports } from './reports/costs';
import { itemReports } from './reports/items';
import { autoTotals, type FilterKey, type ReportContext, type ReportDef, type ReportFilters, type ReportResult, type SaleRent } from './reports/types';

export type { ReportDef, ReportFilters, ReportResult, Col, Row, ReportChart, FilterKey, ReportContext } from './reports/types';
export { periodLabel } from './reports/types';

const bySlug = (list: ReportDef[], slug: string) => list.filter((r) => r.slug === slug);
const [avgPrice, pieces, clientModel, rentClientModel, rentByCategory, importByMonth, failures] = [
  'prosjecna-prodajna-cijena', 'uredaji-po-komadima', 'prihod-klijent-model', 'najam-klijent-model', 'najam-po-kategoriji', 'uvoz-po-mjesecima', 'kvarovi-i-servis',
].map((s) => bySlug(itemReports, s));

/** Svi izvještaji, redom kojim se prikazuju u popisu. */
export const REPORTS: ReportDef[] = [
  ...salesReports, ...avgPrice, ...pieces, ...clientModel,
  ...receivableReports,
  ...rentReports.filter((r) => r.area === 'Najam'), ...rentClientModel, ...rentByCategory,
  ...rentReports.filter((r) => r.area !== 'Najam'), ...importByMonth,
  ...stockReports, ...failures,
  ...costReports,
];

export const REPORT_AREAS = ['Prodaja', 'Naplata', 'Najam', 'Nabava', 'Skladište', 'Servis', 'Troškovi'] as const;

export const findReport = (slug: string) => REPORTS.find((r) => r.slug === slug) ?? null;

/** Izvještaji koje korisnik vidi (bez prava „costs" nestaju oni o marži i nabavnim cijenama). */
export const visibleReports = (ctx: ReportContext) => REPORTS.filter((r) => ctx.canSeeCost || !r.requiresCost);

const TYPE_PARAM: Record<string, SaleRent> = { prodaja: 'SALE', najam: 'RENT' };

/**
 * Filtri iz URL-a: ?godina=2026|sve&od=&do=&partner=a,b&kategorija=…&model=…&status=…&skladiste=…&dobavljac=…&vrsta=prodaja,najam&dana=90.
 * Filtri koje izvještaj ne razumije se zanemaruju.
 */
export function readFilters(def: ReportDef, params: SearchParams | URLSearchParams): ReportFilters {
  const now = Number(today().slice(0, 4));
  const has = (k: FilterKey) => def.filters.includes(k);
  const rawYear = paramStr(params, 'godina');
  const y = Number(rawYear);
  const year = rawYear === 'sve' && has('year') && !def.singleYear ? null : Number.isInteger(y) && y > 2000 && y <= now + 1 ? y : now;
  const d = Number(paramStr(params, 'dana'));
  const range = has('range') ? parseDateRange(params) : { from: null, to: null };
  return {
    year: has('year') ? year : null,
    displayYear: year ?? now,
    from: range.from,
    to: range.to,
    partnerIds: has('partner') ? parseMulti(params, 'partner') : [],
    categoryIds: has('category') ? parseMulti(params, 'kategorija') : [],
    modelIds: has('model') ? parseMulti(params, 'model') : [],
    statusIds: has('status') ? parseMulti(params, 'status') : [],
    warehouseIds: has('warehouse') ? parseMulti(params, 'skladiste') : [],
    supplierIds: has('supplier') ? parseMulti(params, 'dobavljac') : [],
    types: has('type') ? parseMulti(params, 'vrsta', Object.keys(TYPE_PARAM)).map((t) => TYPE_PARAM[t]) : [],
    days: Number.isInteger(d) && d > 0 && d <= 3650 ? d : (def.defaultDays ?? 30),
  };
}

/**
 * Pokreće izvještaj i dopunjuje redak ukupno. Bez prava „costs" izbacuju se
 * stupci nabavnih cijena/marže (i graf koji ih prikazuje) — na ekranu i u izvozu.
 */
export async function runReport(def: ReportDef, companyId: string, f: ReportFilters, ctx: ReportContext): Promise<ReportResult> {
  if (def.requiresCost && !ctx.canSeeCost) return { columns: [{ key: 'x', label: '' }], rows: [], totals: null, note: 'Za ovaj izvještaj potrebno je pravo na nabavne cijene i marže.' };
  const res = await def.run(companyId, f, ctx);
  const columns = ctx.canSeeCost ? res.columns : res.columns.filter((c) => !c.cost);
  // zbroj uvijek preko svih redaka (ne samo prikazane stranice)
  const totals = res.totals === undefined ? autoTotals(columns, res.rows) : res.totals;
  const chart = !ctx.canSeeCost && res.chartCost ? undefined : res.chart;
  // ekran dobiva jednu stranicu (izvještaj ju je možda već odrezao u bazi — tada javlja rowCount); izvoz sve
  if (ctx.page && res.rowCount === undefined) {
    return { ...res, columns, totals, chart, rows: res.rows.slice(ctx.page.skip, ctx.page.skip + ctx.page.take), rowCount: res.rows.length };
  }
  return { ...res, columns, totals, chart };
}
