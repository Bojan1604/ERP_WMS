import Link from 'next/link';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { listProfiles } from '@/server/queries/mdm-library';
import { can } from '@/domain/permissions';
import { PLATFORM_LABEL } from '@/domain/mdm';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { FilterBar, SearchFilter, SegmentFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { PlatformIcon } from '@/components/mdm/common';
import { dateTime } from '@/lib/format';

export const metadata = { title: 'Konfiguracije — MDM' };

type Params = Record<string, string | string[] | undefined>;

export default async function ProfilesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('mdm');
  const scope = await getMdmScope(user);
  const params = await searchParams;
  const page = readPage(params, 50);
  const { rows, total } = await listProfiles(scope, params, page);

  return (
    <>
      <PageHeader
        title="Konfiguracije"
        subtitle="Postavke lokacija i uređaja: aplikacije, zaključani način, Wi-Fi, sustav"
        actions={
          can(user.perms, 'mdm', 'edit') && (
            <LinkButton href="/mdm/profili/nova" variant="primary" icon={<Plus className="size-4" />}>
              Nova konfiguracija
            </LinkButton>
          )
        }
      />
      <FilterBar>
        <SearchFilter placeholder="Naziv konfiguracije…" />
        <SegmentFilter
          name="platform"
          options={[
            { value: '', label: 'Sve' },
            { value: 'ANDROID', label: 'Android' },
            { value: 'WINDOWS', label: 'Windows' },
          ]}
        />
      </FilterBar>
      <TableWrap>
        {rows.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Naziv</th>
                <th>Platforma</th>
                <th>Vlasnik</th>
                <th className="num">Verzija</th>
                <th className="num">Lokacija</th>
                <th className="num">Uređaja</th>
                <th>Izmijenjeno</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="max-w-96">
                    <Link prefetch={false} href={`/mdm/profili/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    {!p.canEdit && (
                      <Badge tone="neutral" className="ml-1.5" title="Mijenja samo vlasnik sustava">
                        samo čitanje
                      </Badge>
                    )}
                    {p.note && <div className="truncate text-xs text-fg-3">{p.note}</div>}
                  </td>
                  <td>
                    <span className="inline-flex items-center gap-1.5">
                      <PlatformIcon platform={p.platform} />
                      {PLATFORM_LABEL[p.platform]}
                    </span>
                  </td>
                  <td>{p.org ? p.org.name : <Badge tone="info">zajednička</Badge>}</td>
                  <td className="num">v{p.version}</td>
                  <td className="num">{p.sites || <span className="text-fg-4">—</span>}</td>
                  <td className="num">
                    {p.devices ? (
                      <Link prefetch={false} href={`/mdm/uredaji?profile=${p.id}`} className="hover:underline">
                        {p.devices}
                      </Link>
                    ) : (
                      <span className="text-fg-4">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-sm text-fg-3">{dateTime(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon={<SlidersHorizontal className="size-5" />} title="Nema konfiguracija" description="Konfiguracija određuje aplikacije, zaključani način, Wi-Fi i postavke sustava uređaja na lokaciji." />
        )}
      </TableWrap>
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath="/mdm/profili" />
    </>
  );
}
