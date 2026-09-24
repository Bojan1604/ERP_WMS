import { notFound } from 'next/navigation';
import { Download, FileText, Loader2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { deviceUploads, getDevice, pendingCommand } from '@/server/queries/mdm';
import { canSendCommand, COMMAND_STATUS_LABEL, type Platform } from '@/domain/mdm';
import { Card, Empty } from '@/components/ui/misc';
import { CommandButton } from '@/components/mdm/device-command-button';
import { AutoRefresh } from '@/components/mdm/commands-refresh';
import { ago, bytes } from '@/components/mdm/common';
import { dateTime } from '@/lib/format';

export const metadata = { title: 'Zapisnici uređaja' };

export default async function DeviceLogsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const { id } = await params;
  const d = await getDevice(scope, id);
  if (!d) notFound();
  const [logs, pending] = await Promise.all([deviceUploads(d.id, 'LOGS', 50), pendingCommand(d.id, 'UPLOAD_LOGS')]);
  const canRequest = d.status === 'ENROLLED' && canSendCommand('UPLOAD_LOGS', d.platform as Platform, scope.level, scope.owner);

  return (
    <div className="space-y-4">
      <AutoRefresh active={!!pending} seconds={3} />
      <div className="flex flex-wrap items-center gap-3">
        {canRequest && <CommandButton ids={[d.id]} type="UPLOAD_LOGS" label="Zatraži zapisnike" variant="primary" />}
        {pending && (
          <span className="inline-flex items-center gap-1.5 text-sm text-fg-3">
            <Loader2 className="size-3.5 animate-spin" />
            {COMMAND_STATUS_LABEL[pending.status]} — zatraženo {ago(pending.createdAt)}
          </span>
        )}
      </div>
      <Card padded={false} title="Preuzeti zapisnici">
        {logs.length ? (
          <ul className="divide-y divide-line">
            {logs.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-medium">
                    <FileText className="size-4 text-fg-3" />
                    <span className="truncate">{l.file.name}</span>
                  </span>
                  <span className="text-sm text-fg-3">
                    {dateTime(l.at)} · {bytes(l.file.size)}
                  </span>
                </span>
                <a href={`/api/mdm/uploads/${l.id}?preuzmi`} className="inline-flex items-center gap-1 text-sm link">
                  <Download className="size-4" /> Preuzmi
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={<FileText className="size-5" />} title="Nema zapisnika" description="Zatražite zapisnike — agent ih šalje pri sljedećem javljanju." />
        )}
      </Card>
    </div>
  );
}
