import Link from 'next/link';
import { AppWindow } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { listApps } from '@/server/queries/mdm-library';
import { orgOptions } from '@/server/queries/mdm';
import { can } from '@/domain/permissions';
import { PLATFORM_LABEL } from '@/domain/mdm';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { FilterBar, SearchFilter, SegmentFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { bytes, PlatformIcon } from '@/components/mdm/common';
import { AppUploadButton } from '@/components/mdm/app-upload';
import { dateTime } from '@/lib/format';

export const metadata = { title: 'Aplikacije — MDM' };

type Params = Record<string, string | string[] | undefined>;

export default async function AppsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('mdm');
  const scope = await getMdmScope(user);
  const params = await searchParams;
  const page = readPage(params, 50);
  const edit = can(user.perms, 'mdm', 'edit');
  const [{ rows, total }, orgs] = await Promise.all([listApps(scope, params, page), edit ? orgOptions(scope, { activeOnly: true }) : []]);

  return (
    <>
      <PageHeader
        title="Aplikacije"
        subtitle="Knjižnica instalacijskih paketa: Android APK i Windows MSI/EXE, s verzijama"
        actions={edit && <AppUploadButton orgs={orgs.map((o) => ({ value: o.id, label: o.label }))} allowShared={scope.owner} />}
      />
      <FilterBar>
        <SearchFilter placeholder="Naziv ili paket…" />
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
                <th>Aplikacija</th>
                <th>Paket</th>
                <th>Platforma</th>
                <th>Najnovija</th>
                <th className="num">Verzija</th>
                <th>Vlasnik</th>
                <th>Učitano</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const v = a.versions[0];
                return (
                  <tr key={a.id}>
                    <td>
                      <Link prefetch={false} href={`/mdm/aplikacije/${a.id}`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                    </td>
                    <td className="max-w-72 truncate font-mono text-sm">{a.packageName}</td>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        <PlatformIcon platform={a.platform} />
                        {PLATFORM_LABEL[a.platform]}
                      </span>
                    </td>
                    <td className="tnum">
                      {v ? (
                        <>
                          {v.version} <span className="text-xs text-fg-3">· {bytes(v.file.size)}</span>
                        </>
                      ) : (
                        <span className="text-fg-4">—</span>
                      )}
                    </td>
                    <td className="num">
                      <Badge tone="brand">{a._count.versions}</Badge>
                    </td>
                    <td>{a.org ? a.org.name : <Badge tone="info">zajednička</Badge>}</td>
                    <td className="whitespace-nowrap text-sm text-fg-3">{v ? dateTime(v.createdAt) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty icon={<AppWindow className="size-5" />} title="Nema aplikacija" description="Učitajte APK (Android) ili MSI/EXE (Windows) — zatim ih dodajte u konfiguraciju ili instalirajte na uređaj." />
        )}
      </TableWrap>
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath="/mdm/aplikacije" />
    </>
  );
}
