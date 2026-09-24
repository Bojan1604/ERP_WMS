import { Download, FolderOpen, Trash2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { listLibraryFiles, pushTargets } from '@/server/queries/mdm-library';
import { orgOptions } from '@/server/queries/mdm';
import { can } from '@/domain/permissions';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { ActionButton } from '@/components/ui/action';
import { FilterBar, SearchFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { bytes } from '@/components/mdm/common';
import { FileUploadButton } from '@/components/mdm/file-upload';
import { FilePushButton } from '@/components/mdm/file-push';
import { dateTime } from '@/lib/format';
import { deleteFileAction, pushFileAction } from './actions';

export const metadata = { title: 'Datoteke — MDM' };

type Params = Record<string, string | string[] | undefined>;

export default async function FilesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('mdm');
  const scope = await getMdmScope(user);
  const params = await searchParams;
  const page = readPage(params, 50);
  const edit = can(user.perms, 'mdm', 'edit');
  const [{ rows, total }, orgs, targets] = await Promise.all([
    listLibraryFiles(scope, 'FILE', params, page),
    edit ? orgOptions(scope, { activeOnly: true }) : [],
    edit ? pushTargets(scope) : { devices: [], sites: [] },
  ]);

  return (
    <>
      <PageHeader
        title="Datoteke"
        subtitle="Datoteke za slanje na uređaje (cjenici, postavke, certifikati, slike…)"
        actions={edit && <FileUploadButton kind="FILE" label="Učitaj datoteku" maxMb={200} orgs={orgs.map((o) => ({ value: o.id, label: o.label }))} allowShared={scope.owner} />}
      />
      <FilterBar>
        <SearchFilter placeholder="Naziv datoteke…" />
      </FilterBar>
      <TableWrap>
        {rows.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Naziv</th>
                <th className="num">Veličina</th>
                <th>Vlasnik</th>
                <th>Učitano</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td>
                    <div className="font-medium">{f.name}</div>
                    <div className="font-mono text-xs text-fg-3" title={`SHA-256 ${f.sha256}`}>
                      {f.mime} · {f.sha256.slice(0, 12)}…
                    </div>
                  </td>
                  <td className="num whitespace-nowrap">{bytes(f.size)}</td>
                  <td>{f.org ? f.org.name : <Badge tone="info">zajednička</Badge>}</td>
                  <td className="whitespace-nowrap text-sm">
                    {dateTime(f.createdAt)}
                    {f.createdBy && <div className="text-xs text-fg-3">{f.createdBy}</div>}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <span className="inline-flex items-center gap-1">
                      {edit && <FilePushButton file={{ id: f.id, name: f.name }} targets={targets} action={pushFileAction} />}
                      <LinkButton size="sm" variant="ghost" href={`/api/mdm/files/${f.id}`} icon={<Download className="size-3.5" />} />
                      {edit && f.canEdit && (
                        <ActionButton size="sm" variant="ghost" action={deleteFileAction} input={{ id: f.id }} icon={<Trash2 className="size-3.5" />} confirm={`Obrisati „${f.name}"?`} confirmLabel="Obriši" />
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon={<FolderOpen className="size-5" />} title="Nema datoteka" description="Učitajte datoteku i pošaljite je na uređaje — agent je sprema u zadanu mapu (Android: Download/, Windows: C:\ProgramData\ERPWMS\files\)." />
        )}
      </TableWrap>
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath="/mdm/datoteke" />
    </>
  );
}
