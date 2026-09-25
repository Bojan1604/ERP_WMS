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
  /** Ukupan broj redaka kad `rows` sadrži samo jednu stranicu (straničenje u bazi ili u runReport). */
  rowCount?: number;
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
  /**
   * Stranica za prikaz na ekranu (izvoz je bez nje i dobiva sve retke). Izvještaj s mnogo redaka
   * može sam straničiti u bazi — tada vraća `rowCount` i `totals` preko svih redaka.
   */
  page?: { skip: number; take: number };
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
 * Stavke prihoda za izvještaje po stavkama (klijent, model, uređaj, kategorija) — izvedena
 * tablica s aliasom po izboru (`FROM (${revenueLinesSql(…)}) l`). Stupci:
 * "invoiceId", "partnerId", "date", "docKind", "modelId", "itemId", "type" (vrsta stavke),
 * "lineKind", qty, cost, net, "isCredit".
 *
 * - `net` je stavka NAKON popusta na cijeli račun (popust se raspoređuje razmjerno, kao
 *   `lineShareOfNet`, u centima metodom najvećeg ostatka), pa je zbroj stavki računa TOČNO osnovica
 *   računa (netTotal) — izvještaji po stavkama se slažu s „Prihod po mjesecima" do centa.
 * - Knjižna odobrenja ulaze kao negativni iznosi raspoređeni na stavke izvornog računa
 *   (razmjerno), s datumom i partnerom odobrenja; količina i nabavna 0.
 * - `withStorno`: računi i storna (negativni) kao u „Prihod po mjesecima" — zbroj po razdoblju
 *   odgovara prihodu. Bez toga: samo važeći (nestornirani) računi — za komade i prosječne cijene.
 * Uvjeti firme, izdanosti, isključenih partnera, razdoblja i partnera su već unutra.
 */
export function revenueLinesSql(
  companyId: string,
  f: Pick<ReportFilters, 'year' | 'from' | 'to' | 'partnerIds'>,
  opts: { withStorno?: boolean; lineType?: SaleRent; deviceOnly?: boolean; withItem?: boolean; docType?: SaleRent } = {},
) {
  // suženja unutar obje grane (isti rezultat kao filtar izvana, ali na stupcima tablica — planer ih dobro
  // procjenjuje pa bira hash spajanja umjesto stotina tisuća pojedinačnih dohvata)
  const narrow = (line: string, doc: string, typeDoc: string) => Prisma.sql`
    ${opts.lineType ? Prisma.sql`AND (${Prisma.raw(line)}."lineType" = ${opts.lineType}::"InvoiceType" OR (${Prisma.raw(line)}."lineType" IS NULL AND ${Prisma.raw(typeDoc)}."type" = ${opts.lineType}::"InvoiceType"))` : Prisma.empty}
    ${opts.deviceOnly ? Prisma.sql`AND ${Prisma.raw(line)}."kind" = 'DEVICE'` : Prisma.empty}
    ${opts.withItem ? Prisma.sql`AND ${Prisma.raw(line)}."itemId" IS NOT NULL` : Prisma.empty}
    ${opts.docType ? Prisma.sql`AND ${Prisma.raw(doc)}."type" = ${opts.docType}::"InvoiceType"` : Prisma.empty}`;
  // udio stavke u osnovici `total` dokumenta `doc` u centima, metodom najvećeg ostatka: zbroj stavki
  // dokumenta je TOČNO `total` (bez razlike od 0,01 zbog zaokruživanja). Računa se samo za dokumente
  // s popustom (CASE), nad svim stavkama dokumenta, pa suženje izvana ne mijenja raspodjelu.
  const alloc = (total: Prisma.Sql, doc: string, line: string) => Prisma.sql`(SELECT z.c FROM (
      SELECT y.id, (y.fl + CASE WHEN ROW_NUMBER() OVER (ORDER BY y.raw - y.fl DESC, y.id) <= ROUND(${total} * 100) - SUM(y.fl) OVER () THEN 1 ELSE 0 END) / 100.0 AS c
      FROM (SELECT w.id, w.raw, FLOOR(w.raw) AS fl FROM (
        SELECT x.id, x."netAmount" * ${total} * 100 / NULLIF(SUM(x."netAmount") OVER (), 0) AS raw FROM "InvoiceLine" x WHERE x."invoiceId" = ${Prisma.raw(doc)}.id
      ) w) y
    ) z WHERE z.id = ${Prisma.raw(line)}.id)`;
  const docs = opts.withStorno
    ? Prisma.sql`i."kind" IN ('INVOICE','STORNO') AND NOT (i."kind" = 'STORNO' AND EXISTS (SELECT 1 FROM "Invoice" r WHERE r.id = i."refInvoiceId" AND r."kind" = 'ADVANCE'))`
    : Prisma.sql`i."kind" = 'INVOICE' AND i."stornoed" = false`;
  return Prisma.sql`
    SELECT i.id AS "invoiceId", i."partnerId", i."date", i."kind"::text AS "docKind", l."modelId", l."itemId", COALESCE(l."lineType", i."type")::text AS "type",
           l."kind"::text AS "lineKind", l."qty", l."cost", false AS "isCredit",
           CASE WHEN i."discountPct" = 0 AND i."discountAmount" = 0 THEN l."netAmount"
                ELSE COALESCE(${alloc(Prisma.sql`i."netTotal"`, 'i', 'l')}, 0) END AS net
    FROM "InvoiceLine" l JOIN "Invoice" i ON i.id = l."invoiceId" JOIN "Partner" p ON p.id = i."partnerId"
    WHERE i."companyId" = ${companyId} AND i."status" = 'ISSUED' AND ${docs} AND p."excluded" = false
      ${periodSql('i."date"', f)} ${inIds('i."partnerId"', f.partnerIds)} ${narrow('l', 'i', 'i')}
    UNION ALL
    SELECT c.id, c."partnerId", c."date", 'CREDIT_NOTE', l."modelId", l."itemId", COALESCE(l."lineType", r."type")::text,
           l."kind"::text, 0, 0, true, COALESCE(${alloc(Prisma.sql`c."netTotal"`, 'r', 'l')}, 0)
    FROM "Invoice" c JOIN "Partner" p ON p.id = c."partnerId" JOIN "Invoice" r ON r.id = c."refInvoiceId" JOIN "InvoiceLine" l ON l."invoiceId" = r.id
    WHERE c."companyId" = ${companyId} AND c."status" = 'ISSUED' AND c."kind" = 'CREDIT_NOTE' AND p."excluded" = false
      ${periodSql('c."date"', f)} ${inIds('c."partnerId"', f.partnerIds)} ${narrow('l', 'c', 'r')}`;
}

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

/** Oznaka razdoblja za naslove („2026." / „sve godine" / „1. 3. 2026. – 31. 5. 2026."). */
export function periodLabel(f: Pick<ReportFilters, 'year' | 'from' | 'to'>): string {
  const { from, to } = periodBounds(f);
  const d = (s: string) => `${Number(s.slice(8, 10))}. ${Number(s.slice(5, 7))}. ${s.slice(0, 4)}.`;
  if (f.from || f.to) return `${from ? d(from) : 'početak'} – ${to ? d(to) : 'danas'}`;
  return f.year ? `${f.year}.` : 'sve godine';
}
