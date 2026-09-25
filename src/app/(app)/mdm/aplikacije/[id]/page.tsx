import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Download, Trash2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { appDetail } from '@/server/queries/mdm-library';
import { can } from '@/domain/permissions';
import { PLATFORM_LABEL } from '@/domain/mdm';
import { Badge, Card, Detail, PageHeader, TableWrap } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { ActionButton } from '@/components/ui/action';
import { bytes, PlatformIcon } from '@/components/mdm/common';
import { AppUploadButton } from '@/components/mdm/app-upload';
import { AppEditButton, VersionNotesButton } from '@/components/mdm/app-edit';
import { dateTime } from '@/lib/format';
import { deleteAppAction, deleteVersionAction, updateAppAction, updateVersionNotesAction } from '../actions';

export const metadata = { title: 'Aplikacija — MDM' };

export default async function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('mdm');
  const scope = await getMdmScope(user);
  const { id } = await params;
  const data = await appDetail(scope, id);
  if (!data) notFound();
  const { app } = data;
  const edit = can(user.perms, 'mdm', 'edit') && data.canEdit;
  const used = data.profiles.length + data.devices.length + data.hiddenRefs > 0;

  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/mdm/aplikacije" className="hover:underline">
            ← Aplikacije
          </Link>
        }
        title={app.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <PlatformIcon platform={app.platform} className="size-3.5" />
            {PLATFORM_LABEL[app.platform]} · <span className="font-mono">{app.packageName}</span> · {app.org ? app.org.name : <Badge tone="info">zajednička</Badge>}
          </span>
        }
        actions={
          edit && (
            <>
              <AppUploadButton app={{ id: app.id, name: app.name, platform: app.platform, packageName: app.packageName, installArgs: app.installArgs }} label="Nova verzija" />
              <AppEditButton app={app} action={updateAppAction} />
              <ActionButton
                action={deleteAppAction}
                input={{ id: app.id }}
                variant="danger"
                disabled={used}
                title={used ? 'Aplikaciju koriste konfiguracije ili uređaji' : undefined}
                icon={<Trash2 className="size-4" />}
                confirm={`Obrisati aplikaciju „${app.name}" i sve njene verzije (${app.versions.length})?`}
                confirmLabel="Obriši"
              >
                Obriši
              </ActionButton>
            </>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0">
          <h2 className="mb-2 text-md font-semibold">Verzije ({app.versions.length})</h2>
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Verzija</th>
                  <th>Datoteka</th>
                  <th>Učitano</th>
                  <th>Koristi</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {app.versions.map((v, i) => (
                  <tr key={v.id}>
                    <td className="whitespace-nowrap">
                      <span className="font-medium tnum">{v.version}</span>
                      {v.versionCode !== null && <span className="ml-1.5 text-xs text-fg-3">({v.versionCode})</span>}
                      {i === 0 && (
                        <Badge tone="ok" className="ml-1.5">
                          najnovija
                        </Badge>
                      )}
                      {v.notes && <div className="max-w-72 whitespace-pre-line text-xs text-fg-3">{v.notes}</div>}
                    </td>
                    <td>
                      <div className="max-w-64 truncate text-sm">{v.file.name}</div>
                      <div className="font-mono text-xs text-fg-3" title={`SHA-256 ${v.file.sha256}`}>
                        {bytes(v.file.size)} · {v.file.sha256.slice(0, 12)}…
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-sm">
                      {dateTime(v.createdAt)}
                      {v.file.createdBy && <div className="text-xs text-fg-3">{v.file.createdBy}</div>}
                    </td>
                    <td className="text-sm max-sm:col-span-2">
                      {[...v.usedBy, ...(i === 0 ? data.latestUsedBy.map((n) => `${n} (najnovija)`) : [])].map((n) => (
                        <Badge key={n} tone="brand" className="mr-1">
                          {n}
                        </Badge>
                      ))}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <LinkButton size="sm" variant="ghost" href={`/api/mdm/files/${v.file.id}`} icon={<Download className="size-3.5" />} />
                      {edit && <VersionNotesButton id={v.id} notes={v.notes} version={v.version} action={updateVersionNotesAction} />}
                      {edit && (
                        <ActionButton
                          size="sm"
                          variant="ghost"
                          action={deleteVersionAction}
                          input={{ id: v.id }}
                          disabled={v.usedBy.length > 0}
                          title={v.usedBy.length ? 'Verziju koristi konfiguracija' : 'Obriši verziju'}
                          icon={<Trash2 className="size-3.5" />}
                          confirm={`Obrisati verziju ${v.version}? Datoteka se briše s poslužitelja; uređaji s „najnovijom" dobivaju sljedeću najnoviju verziju.`}
                          confirmLabel="Obriši"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>
        <div className="space-y-4">
          <Card title="Podaci">
            <dl>
              <Detail label="Paket">
                <span className="break-all font-mono text-sm">{app.packageName}</span>
              </Detail>
              {app.platform === 'WINDOWS' && (
                <Detail label="Tiha instalacija">
                  <span className="font-mono text-sm">{app.installArgs ?? '—'}</span>
                </Detail>
              )}
              <Detail label="Stvoreno">{dateTime(app.createdAt)}</Detail>
            </dl>
            {app.description && <p className="mt-2 whitespace-pre-line text-sm text-fg-2">{app.description}</p>}
          </Card>
          <Card title="Gdje se koristi">
            {data.profiles.length || data.devices.length || data.hiddenRefs ? (
              <ul className="space-y-1.5 text-sm">
                {data.profiles.map((p) => (
                  <li key={p.id} className="flex justify-between gap-2">
                    <Link prefetch={false} href={`/mdm/profili/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                    <span className="text-fg-3">{p.devices} ur.</span>
                  </li>
                ))}
                {data.devices.map((d) => (
                  <li key={d.id}>
                    <Link prefetch={false} href={`/mdm/uredaji/${d.id}/konfiguracija`} className="hover:underline">
                      {d.name}
                    </Link>{' '}
                    <span className="text-fg-3">(izmjena uređaja)</span>
                  </li>
                ))}
                {data.hiddenRefs > 0 && <li className="text-fg-3">+ {data.hiddenRefs} izvan vašeg opsega</li>}
              </ul>
            ) : (
              <p className="text-sm text-fg-3">Nijedna konfiguracija ni uređaj ne koriste ovu aplikaciju.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
