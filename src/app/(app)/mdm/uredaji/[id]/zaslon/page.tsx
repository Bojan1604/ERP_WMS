import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { deviceUploads, getDevice, pendingCommand } from '@/server/queries/mdm';
import { canSendCommand, type Platform } from '@/domain/mdm';
import { ScreenViewer } from '@/components/mdm/screen-viewer';

export const metadata = { title: 'Zaslon uređaja' };

export default async function DeviceScreenPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const { id } = await params;
  const d = await getDevice(scope, id);
  if (!d) notFound();
  const [uploads, pending] = await Promise.all([deviceUploads(d.id, 'SCREENSHOT', 12), pendingCommand(d.id, 'SCREENSHOT')]);
  return (
    <ScreenViewer
      deviceId={d.id}
      enrolled={d.status === 'ENROLLED'}
      canRequest={canSendCommand('SCREENSHOT', d.platform as Platform, scope.level, scope.owner)}
      initial={{
        pending: pending ? { id: pending.id, status: pending.status, createdAt: pending.createdAt.toISOString() } : null,
        uploads: uploads.map((u) => ({ id: u.id, at: u.at.toISOString(), name: u.file.name, size: u.file.size })),
      }}
    />
  );
}
