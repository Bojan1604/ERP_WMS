import { Table2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { can } from '@/domain/permissions';
import { getLookups, getPartnerOptions } from '@/server/queries/lookups';
import { FilterBar, MultiSelectFilter, SearchFilter, SelectFilter, ToggleFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { OverviewGrid } from '@/components/rentals/overview-grid';
import { today } from '@/domain/dates';
import { loadOverview, readFilters } from './data';
import { ExportButtons } from '@/components/ui/export-buttons';
import { ClientSheetButton } from '@/components/partners/client-sheet-link';

export const metadata = { title: 'Pregled najma' };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function RentOverviewPage({ searchParams }: { searchParams: SP }) {
  const user = await pageAccess('rentals', 'view');
  const params = await searchParams;
  const f = readFilters(params);
  const page = readPage(params, 100);
  const [data, lookups, partners] = await Promise.all([
    loadOverview(user.companyId, f, page),
    getLookups(user.companyId),
    getPartnerOptions(user.companyId, 'customer'),
  ]);
  const cy = Number(today().slice(0, 4));
  const years = Array.from({ length: 7 }, (_, i) => cy + 1 - i);
  const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'page')).toString();

  return (
    <>
      <PageHeader
        title="Pregled najma"
        subtitle={`Iznosi naplate po mjesecima za ${f.year}. — ručni upis ima prednost pred izračunom s ugovora`}
        actions={
          <>
            {f.partner && <ClientSheetButton partnerId={f.partner} />}
            <ExportButtons href={`/api/najam/pregled${qs ? `?${qs}` : ''}`} />
          </>
        }
      />
      <FilterBar>
        <SelectFilter name="godina" placeholder={`${cy}.`} options={years.filter((y) => y !== cy).map((y) => ({ value: String(y), label: `${y}.` }))} />
        <SearchFilter placeholder="Serijski, model, klijent…" />
        <SelectFilter name="partner" placeholder="Svi klijenti" options={partners.map((p) => ({ value: p.id, label: p.name }))} />
        <SelectFilter name="kategorija" placeholder="Sve kategorije" options={lookups.categories.map((c) => ({ value: c.id, label: c.name }))} />
        <SelectFilter name="model" placeholder="Svi modeli" options={lookups.models.map((m) => ({ value: m.id, label: [m.brand, m.name].filter(Boolean).join(' ') }))} />
        <MultiSelectFilter name="status" label="Status" options={lookups.statuses.map((st) => ({ value: st.id, label: st.name }))} />
        <MultiSelectFilter
          name="vrsta"
          label="Vrsta"
          options={[
            { value: 'najam', label: 'Najam' },
            { value: 'prodaja', label: 'Prodaja' },
          ]}
        />
        <ToggleFilter name="naplata" label={`Samo s naplatom u ${f.year}.`} />
        <ToggleFilter name="prodani" label="Prodani u godini" />
        <ToggleFilter name="iskljuceni" label="Isključeni partneri" />
      </FilterBar>
      {data.total ? (
        <OverviewGrid year={f.year} rows={data.rows} totals={data.totals} currentMonth={f.year === cy ? Number(today().slice(5, 7)) - 1 : -1} canEdit={can(user.perms, 'rentals', 'edit')} />
      ) : (
        <TableWrap>
          <Empty icon={<Table2 className="size-5" />} title="Nema uređaja za prikaz" description="U godini nema uređaja na ugovoru ni ručnih upisa koji odgovaraju filtrima." />
        </TableWrap>
      )}
      <Pagination page={page.page} pageSize={page.pageSize} total={data.total} params={params} basePath="/najam/pregled" />
    </>
  );
}
