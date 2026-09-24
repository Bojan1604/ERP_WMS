import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Copy, Trash2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { profileEditor } from '@/server/queries/mdm-library';
import { can } from '@/domain/permissions';
import { PLATFORM_LABEL } from '@/domain/mdm';
import { Badge, PageHeader } from '@/components/ui/misc';
import { ActionButton } from '@/components/ui/action';
import { ProfileForm } from '@/components/mdm/profile-form';
import { dateTime } from '@/lib/format';
import { assignSitesAction, deleteProfileAction, duplicateProfileAction, saveProfileAction } from '../actions';

export const metadata = { title: 'Konfiguracija — MDM' };

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('mdm');
  const scope = await getMdmScope(user);
  const { id } = await params;
  const data = await profileEditor(scope, id);
  if (!data) notFound();
  const { profile: p } = data;
  const edit = can(user.perms, 'mdm', 'edit');
  const inUse = data.sites.some((s) => s.assigned) || data.devices > 0;

  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/mdm/profili" className="hover:underline">
            ← Konfiguracije
          </Link>
        }
        title={p.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{PLATFORM_LABEL[p.platform]}</span>·<span>{p.orgName ?? <Badge tone="info">zajednička</Badge>}</span>·<span>v{p.version}</span>·<span>izmijenjeno {dateTime(p.updatedAt)}</span>
          </span>
        }
        actions={
          edit && (
            <>
              <ActionButton action={duplicateProfileAction} input={{ id: p.id }} icon={<Copy className="size-4" />}>
                Kopiraj
              </ActionButton>
              {data.canEdit && (
                <ActionButton
                  action={deleteProfileAction}
                  input={{ id: p.id }}
                  variant="danger"
                  disabled={inUse}
                  title={inUse ? 'Konfiguracija je dodijeljena lokacijama ili uređajima' : undefined}
                  icon={<Trash2 className="size-4" />}
                  confirm={`Obrisati konfiguraciju „${p.name}"?`}
                  confirmLabel="Obriši"
                >
                  Obriši
                </ActionButton>
              )}
            </>
          )
        }
      />
      <ProfileForm
        head={{ id: p.id, name: p.name, platform: p.platform, orgId: p.orgId, orgName: p.orgName, note: p.note, version: p.version }}
        editor={data.editor}
        library={data.library}
        sites={data.sites}
        devices={data.devices}
        readOnly={!edit || !data.canEdit}
        canAssign={edit}
        saveAction={saveProfileAction}
        assignAction={assignSitesAction}
      />
    </>
  );
}
