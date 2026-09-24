import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { getDevice } from '@/server/queries/mdm';
import { can } from '@/domain/permissions';
import { canSendCommand, PLATFORM_LABEL, type Platform } from '@/domain/mdm';
import { PageHeader } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { MoreMenu } from '@/components/ui/more-menu';
import { ActionButton } from '@/components/ui/action';
import { CommandButton, type UiCommand } from '@/components/mdm/device-command-button';
import { DeviceName } from '@/components/mdm/device-edit';
import { DeviceStatusBadge, OnlineBadge, orgPath, PlatformIcon } from '@/components/mdm/common';
import { removeDeviceAction } from '../actions';

const QUICK: UiCommand[] = ['REBOOT', 'SCREENSHOT', 'UPLOAD_LOGS', 'LOCK', 'MESSAGE', 'FORGET', 'WIPE'];

export default async function DeviceLayout({ params, children }: { params: Promise<{ id: string }>; children: React.ReactNode }) {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const { id } = await params;
  const d = await getDevice(scope, id);
  // uređaj izvan opsega se ne razlikuje od nepostojećeg
  if (!d) notFound();
  const platform = d.platform as Platform;
  const commands = d.status === 'ENROLLED' ? QUICK.filter((t) => canSendCommand(t, platform, scope.level, scope.owner)) : [];
  const primary: UiCommand[] = commands.filter((t) => t === 'REBOOT' || t === 'SCREENSHOT');
  const rest = commands.filter((t) => !primary.includes(t));
  const base = `/mdm/uredaji/${d.id}`;
  const canEdit = can(user.perms, 'mdm', 'edit');

  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/mdm/uredaji" className="hover:underline">
            ← Uređaji
          </Link>
        }
        title={<DeviceName id={d.id} name={d.name} canEdit={canEdit} />}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <DeviceStatusBadge status={d.status} />
            {d.status === 'ENROLLED' && <OnlineBadge lastSeenAt={d.lastSeenAt} />}
            <span className="inline-flex items-center gap-1">
              <PlatformIcon platform={platform} className="size-3.5" />
              {PLATFORM_LABEL[platform]}
            </span>
            <span>·</span>
            <span>
              {d.org ? (
                scope.orgIds && !scope.orgIds.includes(d.org.id) ? orgPath(d.org) : (
                  <Link prefetch={false} href={`/mdm/organizacije/${d.org.id}`} className="hover:underline">
                    {orgPath(d.org)}
                  </Link>
                )
              ) : (
                'bez organizacije'
              )}
              {d.site && ` › ${d.site.name}`}
            </span>
          </span>
        }
        actions={
          <>
            {primary.map((t) => (
              <CommandButton key={t} ids={[d.id]} type={t} />
            ))}
            {rest.length > 0 && (
              <MoreMenu>
                {rest.map((t) => (
                  <CommandButton key={t} ids={[d.id]} type={t} variant={t === 'WIPE' || t === 'FORGET' ? 'danger' : 'secondary'} />
                ))}
              </MoreMenu>
            )}
            {canEdit && d.status !== 'ENROLLED' && (
              <ActionButton
                action={removeDeviceAction}
                input={{ id: d.id }}
                variant="danger"
                icon={<Trash2 className="size-4" />}
                confirm={`Ukloniti uređaj „${d.name}" iz popisa? Ako se agent ponovno javi, pojavit će se kao novi uređaj koji čeka upis.`}
                confirmLabel="Ukloni"
              >
                Ukloni
              </ActionButton>
            )}
          </>
        }
      />
      <Tabs
        tabs={[
          { href: base, label: 'Pregled' },
          { href: `${base}/konfiguracija`, label: 'Konfiguracija' },
          { href: `${base}/aplikacije`, label: 'Aplikacije' },
          { href: `${base}/naredbe`, label: 'Naredbe' },
          { href: `${base}/dogadaji`, label: 'Događaji' },
          { href: `${base}/zaslon`, label: 'Zaslon' },
          { href: `${base}/zapisnici`, label: 'Zapisnici' },
        ]}
      />
      {children}
    </>
  );
}
