import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { findReport, readFilters, runReport } from '@/server/queries/reports';
import { getLookups, getPartnerOptions, modelLabel } from '@/server/queries/lookups';
import { today } from '@/domain/dates';
import { PageHeader } from '@/components/ui/misc';
import { PrintButton } from '@/components/ui/print-button';
import { ReportFilters } from '@/components/reports/report-filters';
import { ReportTable } from '@/components/reports/report-table';
import { ReportChart } from '@/components/reports/report-chart';
import { ExportButtons } from '@/components/ui/export-buttons';

type Params = Record<string, string | string[] | undefined>;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: findReport((await params).slug)?.title ?? 'Izvještaj' };
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Params> }) {
  const user = await pageAccess('reports');
  const def = findReport((await params).slug);
  if (!def) notFound();
  const sp = await searchParams;
  const f = readFilters(def, sp);
  const currentYear = Number(today().slice(0, 4));

  const [result, lookups, partners, first] = await Promise.all([
    runReport(def, user.companyId, f),
    def.filters.some((k) => k === 'category' || k === 'model') ? getLookups(user.companyId) : null,
    def.filters.includes('partner') ? getPartnerOptions(user.companyId) : null,
    def.filters.includes('year') ? db.invoice.aggregate({ where: { companyId: user.companyId }, _min: { year: true } }) : null,
  ]);
  const minYear = Math.max(currentYear - 9, Math.min(first?._min.year ?? currentYear, currentYear));
  const years = Array.from({ length: currentYear - minYear + 1 }, (_, i) => minYear + i);
  const qs = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === 'string')).toString();
  const subtitle = [
    def.filters.includes('year') ? `${f.year}.` : null,
    def.filters.includes('days') ? `sljedećih ${f.days} dana` : null,
    f.partnerId ? partners?.find((p) => p.id === f.partnerId)?.name : null,
    f.categoryId ? lookups?.categories.find((c) => c.id === f.categoryId)?.name : null,
    f.modelId ? lookups && modelLabel(lookups.models.find((m) => m.id === f.modelId) ?? { name: '' }) : null,
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
        defaultDays={def.defaultDays ?? 30}
        partners={(partners ?? []).map((p) => ({ value: p.id, label: p.excluded ? `${p.name} (isključen)` : p.name }))}
        categories={(lookups?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
        models={(lookups?.models ?? []).map((m) => ({ value: m.id, label: modelLabel(m) }))}
      />
      <div className="print-area">
        <p className="mb-2 hidden text-lg font-semibold print:block">
          {def.title} {subtitle && <span className="font-normal">— {subtitle}</span>}
        </p>
        {result.chart && <ReportChart spec={result.chart} title={`${def.title}${subtitle ? ` · ${subtitle}` : ''}`} />}
        <ReportTable columns={result.columns} rows={result.rows} totals={result.totals} />
        {result.note && <p className="mt-2 text-sm text-fg-3">{result.note}</p>}
      </div>
    </>
  );
}
