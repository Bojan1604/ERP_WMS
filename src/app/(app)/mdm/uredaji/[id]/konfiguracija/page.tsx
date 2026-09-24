import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { getDevice } from '@/server/queries/mdm';
import { deviceConfig } from '@/server/queries/mdm-library';
import { can } from '@/domain/permissions';
import { DeviceConfig } from '@/components/mdm/config-device';
import { applyConfigNowAction, clearDeviceOverridesAction, saveDeviceOverridesAction, setDeviceProfileAction } from './actions';

export const metadata = { title: 'Konfiguracija uređaja — MDM' };

export default async function DeviceConfigPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const { id } = await params;
  // opseg se provjerava i ovdje — notFound() u layoutu ne zaustavlja iscrtavanje stranice
  if (!(await getDevice(scope, id))) notFound();
  const data = await deviceConfig(scope, id);
  if (!data) notFound();
  return (
    <DeviceConfig
      // nakon spremanja (nova verzija) uređivač se puni iznova iz spremljenog stanja
      key={`${data.device.profileId ?? '-'}:${data.device.configVersion}`}
      {...data}
      canEdit={can(user.perms, 'mdm', 'edit')}
      actions={{ setProfile: setDeviceProfileAction, save: saveDeviceOverridesAction, clear: clearDeviceOverridesAction, apply: applyConfigNowAction }}
    />
  );
}
