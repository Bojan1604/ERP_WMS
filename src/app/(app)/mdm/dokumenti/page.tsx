import { headers } from 'next/headers';
import { BookOpen, Download, ExternalLink, Trash2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { env } from '@/server/env';
import { getMdmScope } from '@/server/mdm/scope';
import { listLibraryFiles } from '@/server/queries/mdm-library';
import { orgOptions } from '@/server/queries/mdm';
import { can } from '@/domain/permissions';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { ActionButton } from '@/components/ui/action';
import { Tabs } from '@/components/ui/tabs';
import { Pagination, readPage } from '@/components/ui/pagination';
import { bytes } from '@/components/mdm/common';
import { FileUploadButton } from '@/components/mdm/file-upload';
import { NetworkInfo } from '@/components/mdm/doc-network';
import { dateTime } from '@/lib/format';
import { deleteFileAction } from '../datoteke/actions';

export const metadata = { title: 'Dokumenti i mreža — MDM' };

type Params = Record<string, string | string[] | undefined>;

async function serverUrl() {
  const fromEnv = env().APP_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export default async function DocsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('mdm');
  const scope = await getMdmScope(user);
  const params = await searchParams;
  const tab = params.tab === 'mreza' ? 'mreza' : 'dokumenti';
  const edit = can(user.perms, 'mdm', 'edit');

  return (
    <>
      <PageHeader title="Dokumenti i mreža" subtitle="Upute, priručnici i mrežni zahtjevi za uređaje" />
      <Tabs
        param="tab"
        tabs={[
          { href: '/mdm/dokumenti', label: 'Dokumenti' },
          { href: '/mdm/dokumenti?tab=mreza', label: 'Mreža' },
        ]}
      />
      {tab === 'mreza' ? <NetworkInfo serverUrl={await serverUrl()} /> : <DocList scope={scope} params={params} edit={edit} />}
    </>
  );
}

async function DocList({ scope, params, edit }: { scope: Awaited<ReturnType<typeof getMdmScope>>; params: Params; edit: boolean }) {
  const page = readPage(params, 50);
  const [{ rows, total }, orgs] = await Promise.all([listLibraryFiles(scope, 'DOC', params, page), edit ? orgOptions(scope, { activeOnly: true }) : []]);
  return (
    <>
      {edit && (
        <div className="mb-3 flex justify-end">
          <FileUploadButton
            kind="DOC"
            label="Učitaj dokument"
            maxMb={50}
            accept=".pdf,.doc,.docx,.xls,.xlsx,.odt,.txt,.png,.jpg,.jpeg,.zip"
            orgs={orgs.map((o) => ({ value: o.id, label: o.label }))}
            allowShared={scope.owner}
          />
        </div>
      )}
      <TableWrap>
        {rows.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Dokument</th>
                <th className="num">Veličina</th>
                <th>Vidljivo</th>
                <th>Učitano</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td className="font-medium">
                    {f.mime === 'application/pdf' ? (
                      <a href={`/api/mdm/files/${f.id}?prikaz`} target="_blank" rel="noopener" className="hover:underline">
                        {f.name}
                      </a>
                    ) : (
                      f.name
                    )}
                  </td>
                  <td className="num whitespace-nowrap">{bytes(f.size)}</td>
                  <td>{f.org ? f.org.name : <Badge tone="info">svi</Badge>}</td>
                  <td className="whitespace-nowrap text-sm">{dateTime(f.createdAt)}</td>
                  <td className="whitespace-nowrap text-right">
                    {f.mime === 'application/pdf' && <LinkButton size="sm" variant="ghost" href={`/api/mdm/files/${f.id}?prikaz`} target="_blank" icon={<ExternalLink className="size-3.5" />} />}
                    <LinkButton size="sm" variant="ghost" href={`/api/mdm/files/${f.id}`} icon={<Download className="size-3.5" />} />
                    {edit && f.canEdit && (
                      <ActionButton size="sm" variant="ghost" action={deleteFileAction} input={{ id: f.id }} icon={<Trash2 className="size-3.5" />} confirm={`Obrisati dokument „${f.name}"?`} confirmLabel="Obriši" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon={<BookOpen className="size-5" />} title="Nema dokumenata" description="Ovdje su upute za instalaciju, priručnici i drugi dokumenti za distributere i klijente." />
        )}
      </TableWrap>
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath="/mdm/dokumenti" />
    </>
  );
}
