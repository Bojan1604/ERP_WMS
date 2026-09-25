import Link from 'next/link';
import { TrendingUp } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { can } from '@/domain/permissions';
import { getLookups } from '@/server/queries/lookups';
import { partnerOptionsByIds } from '@/server/queries/partner-options';
import { PartnerMultiFilter } from '@/components/partners/partner-combobox';
import { business, marginGroupsPage, marginTotals, marginYears, modelMargins, readMarginFilters, soldItems, type MarginFilters, type MarginGroup } from '@/server/queries/margins';
import { PageHeader, Card, Stat, TableWrap, Empty, Badge } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { DateRangeFilter, FilterBar, MultiSelectFilter, SearchFilter, SegmentFilter } from '@/components/ui/filters';
import { ExportButtons } from '@/components/ui/export-buttons';
import { Pagination, readPage } from '@/components/ui/pagination';
import { BarChart } from '@/components/charts/bar-chart';
import { HBarChart } from '@/components/charts/hbar-chart';
import { GlobalMarginForm, ModelMarginInput } from '@/components/sales/margin-controls';
import { PackageEditor } from '@/components/sales/package-controls';
import { PackagesView } from './packages-view';
import { amount, date, eur, integer, pct } from '@/lib/format';
import { cn } from '@/lib/cn';
import { plural } from '@/domain/plural';

export const metadata = { title: 'Marže i profit' };

type SP = Record<string, string | string[] | undefined>;
const BASE = '/prodaja/marze';
const MONTH = ['sij', 'velj', 'ožu', 'tra', 'svi', 'lip', 'srp', 'kol', 'ruj', 'lis', 'stu', 'pro'];

const VIEWS: Array<[MarginFilters['view'], string]> = [
  ['poslovanje', 'Poslovanje'],
  ['artikl', 'Po artiklu'],
  ['kupac', 'Po kupcu'],
  ['model', 'Po modelu'],
  ['kategorija', 'Po kategoriji'],
  ['marze', 'Preporučene marže'],
  ['paketi', 'Paketi'],
];

/** Marže i profit — samo uz pravo „Nabavne cijene i marže" (costs). */
export default async function MarginsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await pageAccess('costs', 'view');
  const sp = await searchParams;
  const f = readMarginFilters(sp);
  const edit = can(user.perms, 'sales', 'edit');
  const [years, lookups, partners] = await Promise.all([marginYears(user.companyId), getLookups(user.companyId), partnerOptionsByIds(user.companyId, f.partners)]);
  const keep = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v && k !== 'page' && k !== 'pogled') keep.set(k, v);
  // zadani pogled (poslovanje) bez parametra — kartica je tada označena
  const tabHref = (v: string) => `${BASE}?${new URLSearchParams([...keep.entries(), ...(v === 'poslovanje' ? [] : [['pogled', v]])])}`;
  const exportQs = new URLSearchParams([...keep.entries(), ['pogled', f.view]]);
  const cur = String(years[0] ?? '');
  const catalog = {
    models: lookups.models.map((m) => ({ id: m.id, brand: m.brand, name: m.name, categoryId: m.categoryId, salePrice: null, warrantyMonths: m.warrantyMonths, kpd: m.kpd })),
    categories: lookups.categories,
    warehouses: lookups.warehouses,
  };

  return (
    <>
      <PageHeader
        title="Marže i profit"
        subtitle={f.from || f.to ? `${f.from ? date(f.from) : 'početak'} – ${f.to ? date(f.to) : 'danas'}` : f.year === 'sve' ? 'Sve godine' : `Godina ${f.year}`}
        actions={
          <>
            {['artikl', 'kupac', 'model', 'kategorija'].includes(f.view) && <ExportButtons href={`/api/prodaja/marze?${exportQs}`} />}
            {f.view === 'paketi' && edit && <PackageEditor catalog={catalog} />}
          </>
        }
      />
      <Tabs tabs={VIEWS.map(([v, label]) => ({ href: tabHref(v), label }))} param="pogled" />
      {f.view === 'paketi' && (
        <FilterBar>
          <SearchFilter placeholder="Naziv paketa, napomena, serijski broj…" />
        </FilterBar>
      )}
      {f.view !== 'marze' && f.view !== 'paketi' && (
        <FilterBar>
          <SegmentFilter name="godina" options={[{ value: '', label: cur }, ...years.slice(1, 5).map((y) => ({ value: String(y), label: String(y) })), { value: 'sve', label: 'Sve' }]} />
          <SearchFilter placeholder="Serijski broj, model, kupac…" />
          <DateRangeFilter label="Razdoblje" />
          <PartnerMultiFilter name="kupac" label="Kupac" role="customer" selected={partners} />
          <MultiSelectFilter name="kategorija" label="Kategorija" options={lookups.categories.map((c) => ({ value: c.id, label: c.name }))} />
          <MultiSelectFilter name="model" label="Model" options={lookups.models.map((m) => ({ value: m.id, label: [m.brand, m.name].filter(Boolean).join(' ') }))} />
        </FilterBar>
      )}
      {f.view === 'poslovanje' && <BusinessView companyId={user.companyId} f={f} />}
      {f.view === 'artikl' && <ItemsView companyId={user.companyId} f={f} sp={sp} />}
      {(f.view === 'kupac' || f.view === 'model' || f.view === 'kategorija') && <GroupsView companyId={user.companyId} f={f} by={f.view} sp={sp} />}
      {f.view === 'marze' && <ModelsView companyId={user.companyId} canEdit={edit} />}
      {f.view === 'paketi' && <PackagesView companyId={user.companyId} f={f} edit={edit} catalog={catalog} />}
    </>
  );
}

async function TotalsStats({ companyId, f }: { companyId: string; f: MarginFilters }) {
  const t = await marginTotals(companyId, f);
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
      <Stat label="Prodanih uređaja" value={integer(t.sold)} />
      {t.unpriced > 0 && <Stat label="Bez prodajne cijene" value={integer(t.unpriced)} tone="warn" hint="nije povezano s računom" />}
      <Stat label="Prihod" value={eur(t.revenue)} />
      <Stat label="Nabavna vrijednost" value={eur(t.cost)} />
      <Stat label="Profit" value={eur(t.profit)} tone={t.profit >= 0 ? 'ok' : 'bad'} />
      <Stat label="Bruto marža" value={pct(t.margin)} hint="udio u prihodu" />
      <Stat label="Prosj. nabavna" value={eur(t.avgCost)} />
      <Stat label="Prosj. prodajna" value={eur(t.avgPrice)} />
    </div>
  );
}

async function BusinessView({ companyId, f }: { companyId: string; f: MarginFilters }) {
  const d = await business(companyId, f);
  const result = d.revenue - d.expense;
  const types = [
    ['Prodaja opreme', d.byType.oprema],
    ['Najam', d.byType.najam],
    ['Usluge i ostalo', d.byType.usluge],
  ].filter(([, v]) => v !== 0) as Array<[string, number]>;
  const eqMargin = d.equipment.revenue ? d.equipment.revenue - d.equipment.cost : 0;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Prihodi bez PDV-a" value={eur(d.revenue)} hint={`${integer(d.invoices)} ${plural(d.invoices, 'račun', 'računa', 'računa')}`} />
        <Stat label="Rashodi bez PDV-a" value={eur(d.expense)} tone="bad" hint={`${integer(d.expenseN)} ${plural(d.expenseN, 'stavka', 'stavke', 'stavki')}`} />
        <Stat label="Rezultat" value={eur(result)} tone={result >= 0 ? 'ok' : 'bad'} hint={`${pct(d.revenue ? (result / d.revenue) * 100 : null)} od prihoda`} />
        <Stat label="Naplaćeno" value={eur(d.paid)} tone="ok" hint={`${pct(d.revenue ? (d.paid / d.revenue) * 100 : null)} prihoda`} />
        <Stat label="Nenaplaćeno" value={eur(d.open)} tone="warn" hint={`od toga kasni ${eur(d.late)}`} />
        <Stat label="Bruto marža na opremi" value={pct(d.equipment.margin)} hint={`${eur(eqMargin)} na ${eur(d.equipment.cost)} nabave`} />
      </div>
      <Card title="Prihodi, rashodi i rezultat po mjesecima" className="mb-4">
        {d.months.some((m) => m.income || m.expense) ? (
          <>
            <BarChart
              data={d.months.map((m) => ({ label: MONTH[m.month - 1], values: { income: m.income, expense: -m.expense, result: m.result } }))}
              series={[
                { key: 'income', label: 'Prihod', slot: 0 },
                { key: 'expense', label: 'Rashod', slot: 5 },
                { key: 'result', label: 'Rezultat', slot: 1 },
              ]}
              stacked={false}
              width={1100}
              height={260}
              ariaLabel="Prihodi, rashodi i rezultat po mjesecima"
              className="max-sm:hidden"
            />
            <BarChart
              data={d.months.map((m) => ({ label: MONTH[m.month - 1], values: { result: m.result } }))}
              series={[{ key: 'result', label: 'Rezultat', slot: 1 }]}
              width={440}
              height={240}
              ariaLabel="Rezultat po mjesecima"
              className="sm:hidden"
            />
          </>
        ) : (
          <p className="py-6 text-center text-sm text-fg-3">Nema prometa u razdoblju.</p>
        )}
      </Card>
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Prihodi po vrsti" padded={false}>
          <SimpleTable rows={types.map(([k, v]) => [k, v])} total={d.revenue} />
        </Card>
        <Card title="Rashodi po kategoriji" padded={false}>
          <SimpleTable rows={d.expenseByCategory.map((x) => [x.name, x.amount])} total={d.expense} />
        </Card>
        <Card title="Struktura rashoda">
          {d.expenseByCategory.length ? (
            <HBarChart rows={d.expenseByCategory.slice(0, 10).map((x) => ({ label: x.name, value: x.amount }))} slot={5} />
          ) : (
            <p className="py-6 text-center text-sm text-fg-3">Nema troškova u razdoblju.</p>
          )}
        </Card>
      </div>
      <Card title={`Kupci u razdoblju (${d.customers.length})`} padded={false}>
        <TableWrap className="max-h-96">
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Kupac</th>
                <th className="num">Računa</th>
                <th className="num">Prihod</th>
                <th className="num">Nenaplaćeno</th>
                <th className="num">Udio</th>
              </tr>
            </thead>
            <tbody>
              {d.customers.map((c) => (
                <tr key={c.id}>
                  <td className="max-sm:col-span-2">
                    <Link prefetch={false} href={`/partneri/${c.id}`} className="link">
                      {c.name}
                    </Link>
                  </td>
                  <td className="num">{integer(c.n)}</td>
                  <td className="num">{amount(c.net)}</td>
                  <td className={cn('num', c.open > 0 && 'text-warn')}>{c.open ? amount(c.open) : '—'}</td>
                  <td className="num text-fg-3">{pct(d.revenue ? (c.net / d.revenue) * 100 : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      <p className="mt-3 text-xs text-fg-3">
        <b>Svi iznosi su bez PDV-a.</b> Prihod je osnovica izdanih računa (storno i odobrenja umanjuju), rashod je iznos troška bez pretporeza. Rashodi uključuju
        automatski knjiženu nabavu iz modula Troškovi. Bruto marža na opremi računa se samo na prodanim uređajima s poznatom prodajnom cijenom. Isključeni partneri ne
        ulaze u izračun.
      </p>
    </>
  );
}

function SimpleTable({ rows, total }: { rows: Array<[string, number]>; total: number }) {
  if (!rows.length) return <p className="px-4 py-6 text-center text-sm text-fg-3">Nema podataka u razdoblju.</p>;
  return (
    <table className="data-table compact">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td className="num">{amount(v)}</td>
            <td className="num text-fg-3">{pct(total ? (v / total) * 100 : null)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Ukupno</td>
          <td className="num">{amount(total)}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}

async function ItemsView({ companyId, f, sp }: { companyId: string; f: MarginFilters; sp: SP }) {
  const page = readPage(sp, 100);
  const list = await soldItems(companyId, f, page);
  return (
    <>
      <TotalsStats companyId={companyId} f={f} />
      <TableWrap>
        {list.rows.length === 0 ? (
          <Empty icon={<TrendingUp className="size-5" />} title="Nema prodaje u odabranom razdoblju" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Serijski broj</th>
                <th>Model</th>
                <th>Kategorija</th>
                <th>Kupac</th>
                <th>Račun</th>
                <th>Datum</th>
                <th className="num">Nabavna</th>
                <th className="num">Preporučena</th>
                <th className="num">Prodajna</th>
                <th className="num">Profit</th>
                <th className="num">Bruto marža</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-sm">
                    <Link prefetch={false} href={`/skladiste/${r.id}`} className="link">
                      {r.serial}
                    </Link>
                  </td>
                  <td>{r.model}</td>
                  <td className="text-fg-3">{r.category ?? '—'}</td>
                  <td className="max-w-56 truncate">{r.partner ?? '—'}</td>
                  <td className="whitespace-nowrap">
                    {r.invoice ? (
                      <Link prefetch={false} href={`/prodaja/racuni/${r.invoice.id}`} className="link">
                        {r.invoice.number ?? 'nacrt'}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="whitespace-nowrap">{r.date ? date(r.date) : '—'}</td>
                  <td className="num">{amount(r.cost)}</td>
                  <td className="num text-fg-3">{amount(r.suggested)}</td>
                  <td className="num">{r.price && r.price > 0 ? amount(r.price) : '—'}</td>
                  <td className={cn('num', r.profit !== null && (r.profit >= 0 ? 'text-ok' : 'text-bad-strong'))}>{r.profit === null ? '—' : amount(r.profit)}</td>
                  <td className="num">{pct(r.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      <Pagination page={page.page} pageSize={page.pageSize} total={list.total} params={sp} basePath={BASE} />
    </>
  );
}

async function GroupsView({ companyId, f, by, sp }: { companyId: string; f: MarginFilters; by: 'kupac' | 'model' | 'kategorija'; sp: SP }) {
  const page = readPage(sp, 100);
  const { rows, total } = await marginGroupsPage(companyId, f, by, page);
  const label = by === 'kupac' ? 'Kupac' : by === 'model' ? 'Model' : 'Kategorija';
  return (
    <>
      <TotalsStats companyId={companyId} f={f} />
      {rows.length > 0 && page.page === 1 && (
        <Card title={`Profit po ${by === 'kupac' ? 'kupcu' : by === 'model' ? 'modelu' : 'kategoriji'} (prvih 15)`} className="mb-4">
          <HBarChart rows={rows.slice(0, 15).map((r) => ({ label: r.label, value: r.profit }))} slot={1} />
        </Card>
      )}
      <GroupTable rows={rows} label={label} />
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={sp} basePath={BASE} />
    </>
  );
}

function GroupTable({ rows, label }: { rows: MarginGroup[]; label: string }) {
  if (!rows.length) {
    return (
      <TableWrap>
        <Empty icon={<TrendingUp className="size-5" />} title="Nema podataka" description="Za zadane filtre nema prodanih uređaja s prodajnom cijenom." />
      </TableWrap>
    );
  }
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.profit)));
  return (
    <TableWrap>
      <table className="data-table">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="num">Uređaja</th>
            <th className="num">Nabavna</th>
            <th className="num">Prihod</th>
            <th className="num">Profit</th>
            <th className="num">Bruto marža</th>
            <th className="num">Prosj. prodajna</th>
            <th className="w-36 max-sm:hidden" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key ?? '-'}>
              <td className="max-sm:col-span-2">{r.label}</td>
              <td className="num">{integer(r.n)}</td>
              <td className="num">{amount(r.cost)}</td>
              <td className="num">{amount(r.revenue)}</td>
              <td className={cn('num font-medium', r.profit >= 0 ? 'text-ok' : 'text-bad-strong')}>{amount(r.profit)}</td>
              <td className="num">{pct(r.margin)}</td>
              <td className="num">{amount(r.avgPrice)}</td>
              <td className="max-sm:hidden">
                <div className="h-2 rounded-full bg-muted">
                  <div className={cn('h-2 rounded-full', r.profit >= 0 ? 'bg-ok' : 'bg-bad-strong')} style={{ width: `${(Math.abs(r.profit) / max) * 100}%` }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

async function ModelsView({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const d = await modelMargins(companyId);
  return (
    <Card title="Preporučena bruto marža po modelu" padded={false} actions={canEdit ? <GlobalMarginForm value={d.global} /> : <Badge>Globalna {d.global} %</Badge>}>
      <p className="px-4 pt-3 text-xs text-fg-3">
        Bruto marža je udio zarade u prodajnoj cijeni: (prodajna − nabavna) ÷ prodajna. Preporučena cijena = nabavna ÷ (1 − marža). Prazno polje znači da model koristi
        globalnu maržu; marža upisana na pojedinom uređaju ima prednost pred obje, a prodajna cijena modela pred izračunom iz marže.
      </p>
      <TableWrap className="shadow-none">
        <table className="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Kategorija</th>
              <th className="num">Uređaja</th>
              <th className="num">Na skladištu</th>
              <th className="num">Prosj. nabavna</th>
              <th className="num">Bruto marža %</th>
              <th className="num">Preporučena cijena</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.id}>
                <td className="font-medium max-sm:col-span-2">{r.name}</td>
                <td className="text-fg-3">{r.category ?? '—'}</td>
                <td className="num">{integer(r.devices)}</td>
                <td className="num">{integer(r.stock)}</td>
                <td className="num">{amount(r.avgCost)}</td>
                <td className="num">
                  <ModelMarginInput modelId={r.id} value={r.marginPct} global={d.global} disabled={!canEdit} />
                </td>
                <td className={cn('num font-medium', r.marginPct !== null && 'text-brand')}>
                  {amount(r.price)}
                  {r.salePrice !== null && <span className="block text-xs font-normal text-fg-3">cijena modela {amount(r.salePrice)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}
