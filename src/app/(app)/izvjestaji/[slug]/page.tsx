import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { findReport, periodLabel, readFilters, runReport } from '@/server/queries/reports';
import { getLookups, getPartnerOptions, modelLabel } from '@/server/queries/lookups';
import { canSeeCost } from '@/domain/permissions';
import { today } from '@/domain/dates';
import { PageHeader } from '@/components/ui/misc';
import { PrintButton } from '@/components/ui/print-button';
import { ReportFilters } from '@/components/reports/report-filters';
import { ReportTable } from '@/components/reports/report-table';
import { ReportChart } from '@/components/reports/report-chart';
import { ExportButtons } from '@/components/ui/export-buttons';
import { Pagination, readPage } from '@/components/ui/pagination';

type Params = Record<string, string | string[] | undefined>;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: findReport((await params).slug)?.title ?? 'Izvještaj' };
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Params> }) {
  const user = await pageAccess('reports');
  const def = findReport((await params).slug);
  const costs = canSeeCost(user.perms);
  if (!def || (def.requiresCost && !costs)) notFound();
  const sp = await searchParams;
  const f = readFilters(def, sp);
  const currentYear = Number(today().slice(0, 4));
  // velike tablice po stranicama (zbroj je preko svih redaka, izvoz sadrži sve)
  const pg = readPage(sp, 200);
  const needsLookups = def.filters.some((k) => ['category', 'model', 'status', 'warehouse'].includes(k));

  const [result, lookups, partners, suppliers, first] = await Promise.all([
    runReport(def, user.companyId, f, { canSeeCost: costs, page: { skip: pg.skip, take: pg.take } }),
    needsLookups ? getLookups(user.companyId) : null,
    def.filters.includes('partner') ? getPartnerOptions(user.companyId) : null,
    def.filters.includes('supplier') ? getPartnerOptions(user.companyId, 'supplier') : null,
    def.filters.includes('year') ? db.invoice.aggregate({ where: { companyId: user.companyId }, _min: { year: true } }) : null,
  ]);
  const minYear = Math.max(currentYear - 9, Math.min(first?._min.year ?? currentYear, currentYear));
  const years = Array.from({ length: currentYear - minYear + 1 }, (_, i) => minYear + i);
  const qs = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'page')).toString();
  const rowCount = result.rowCount ?? result.rows.length;
  const names = <T extends { id: string }>(list: T[] | undefined | null, ids: string[], label: (x: T) => string) =>
    ids.length ? ids.map((id) => list?.find((x) => x.id === id)).filter((x): x is T => !!x).map(label).join(', ') : null;
  const subtitle = [
    def.filters.includes('year') || f.from || f.to ? periodLabel(f) : null,
    def.filters.includes('days') ? `sljedećih ${f.days} dana` : null,
    f.types.length ? f.types.map((t) => (t === 'SALE' ? 'prodaja' : 'najam')).join(', ') : null,
    names(partners, f.partnerIds, (p) => p.name),
    names(lookups?.categories, f.categoryIds, (c) => c.name),
    names(lookups?.models, f.modelIds, (m) => modelLabel(m)),
    names(lookups?.statuses, f.statusIds, (x) => x.name),
    names(lookups?.warehouses, f.warehouseIds, (w) => w.name),
    names(suppliers, f.supplierIds, (p) => p.name),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <div className="no-print">
        <PageHeader
          back={
            <Link prefetch={false} href="/izvjestaji" className="hover:underline">
              ← Izvještaji · {def.area}
            </Link>
          }
          title={def.title}
          subtitle={def.description}
          actions={
            <>
              <PrintButton label="Ispis" />
              <ExportButtons href={`/api/izvjestaji/${def.slug}${qs ? `?${qs}` : ''}`} />
            </>
          }
        />
      </div>
      <ReportFilters
        filters={def.filters}
        years={years}
        currentYear={currentYear}
        allYears={!def.singleYear}
        defaultDays={def.defaultDays ?? 30}
        partners={(partners ?? []).map((p) => ({ value: p.id, label: p.excluded ? `${p.name} (isključen)` : p.name }))}
        suppliers={(suppliers ?? []).map((p) => ({ value: p.id, label: p.name }))}
        categories={(lookups?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
        models={(lookups?.models ?? []).map((m) => ({ value: m.id, label: modelLabel(m) }))}
        statuses={(lookups?.statuses ?? []).map((x) => ({ value: x.id, label: x.name }))}
        warehouses={(lookups?.warehouses ?? []).map((w) => ({ value: w.id, label: w.name }))}
      />
      {/* široki izvještaji (npr. starost potraživanja) na A4 položeno da stanu svi stupci */}
      {result.columns.length > 6 && <style>{'@media print { @page { size: A4 landscape; margin: 10mm 8mm; } }'}</style>}
      <div className="print-area">
        <p className="mb-2 hidden text-lg font-semibold print:block">
          {def.title} {subtitle && <span className="font-normal">— {subtitle}</span>}
        </p>
        {subtitle && <p className="no-print mb-2 text-sm text-fg-3">{subtitle}</p>}
        {result.chart && <ReportChart spec={result.chart} title={`${def.title}${subtitle ? ` · ${subtitle}` : ''}`} />}
        <ReportTable columns={result.columns} rows={result.rows} totals={result.totals} />
        {rowCount > pg.take && <Pagination page={pg.page} pageSize={pg.take} total={rowCount} params={sp} basePath={`/izvjestaji/${def.slug}`} />}
        {rowCount > pg.take && (
          <p className="mt-1 hidden text-xs print:block">
            Stranica {pg.page} od {Math.ceil(rowCount / pg.take)} ({rowCount} redaka) — za sve retke koristite izvoz.
          </p>
        )}
        {result.note && <p className="mt-2 text-sm text-fg-3">{result.note}</p>}
      </div>
    </>
  );
}
