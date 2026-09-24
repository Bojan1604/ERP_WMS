import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { getDevice } from '@/server/queries/mdm';
import { deviceApps } from '@/server/queries/mdm-library';
import { can } from '@/domain/permissions';
import { DeviceApps } from '@/components/mdm/app-device';
import { installAppAction, uninstallAppAction } from './actions';

export const metadata = { title: 'Aplikacije uređaja — MDM' };

export default async function DeviceAppsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const { id } = await params;
  // opseg se provjerava i ovdje — notFound() u layoutu ne zaustavlja iscrtavanje stranice
  if (!(await getDevice(scope, id))) notFound();
  const data = await deviceApps(scope, id);
  if (!data) notFound();
  return (
    <DeviceApps
      device={data.device}
      rows={data.rows}
      library={data.library}
      pending={data.pending}
      canEdit={can(user.perms, 'mdm', 'edit')}
      install={installAppAction}
      uninstall={uninstallAppAction}
    />
  );
}
