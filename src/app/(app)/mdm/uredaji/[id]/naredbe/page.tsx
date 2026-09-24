import { notFound } from 'next/navigation';
import { Terminal, X } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { deviceCommands, getDevice } from '@/server/queries/mdm';
import { can } from '@/domain/permissions';
import { COMMAND_STATUS_LABEL, COMMANDS, type CommandType } from '@/domain/mdm';
import { Badge, Empty, TableWrap } from '@/components/ui/misc';
import { Pagination, readPage } from '@/components/ui/pagination';
import { ActionButton } from '@/components/ui/action';
import { COMMAND_STATUS_TONE } from '@/components/mdm/common';
import { AutoRefresh } from '@/components/mdm/commands-refresh';
import { dateTime } from '@/lib/format';
import { cancelCommandAction } from '../../actions';

export const metadata = { title: 'Naredbe uređaja' };

type Params = Record<string, string | string[] | undefined>;

function summary(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return String(v);
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return null;
  return entries.map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`).join(', ').slice(0, 300);
}

export default async function DeviceCommandsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const { id } = await params;
  const sp = await searchParams;
  const d = await getDevice(scope, id);
  if (!d) notFound();
  const pg = readPage(sp, 50);
  const list = await deviceCommands(d.id, pg);
  const canOps = can(user.perms, 'mdm', 'ops');

  return (
    <>
      <AutoRefresh active={list.rows.some((c) => c.status === 'PENDING' || c.status === 'SENT')} seconds={5} />
      <TableWrap>
        {list.rows.length ? (
          <table className="data-table min-w-[900px] max-sm:min-w-0">
            <thead>
              <tr>
                <th>Naredba</th>
                <th>Stanje</th>
                <th>Poslao</th>
                <th>Zadano</th>
                <th>Preuzeto</th>
                <th>Završeno</th>
                <th>Rezultat</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.rows.map((c) => {
                const payload = summary(c.payload);
                const result = c.error ?? summary(c.result);
                return (
                  <tr key={c.id}>
                    <td>
                      <span className="font-medium">{COMMANDS[c.type as CommandType]?.label ?? c.type}</span>
                      {payload && <div className="max-w-72 truncate text-xs text-fg-3" title={payload}>{payload}</div>}
                    </td>
                    <td>
                      <Badge tone={COMMAND_STATUS_TONE[c.status] ?? 'neutral'}>{COMMAND_STATUS_LABEL[c.status] ?? c.status}</Badge>
                    </td>
                    <td className="text-fg-2">{c.createdBy ?? '—'}</td>
                    <td className="whitespace-nowrap">{dateTime(c.createdAt)}</td>
                    <td className="whitespace-nowrap text-fg-2">{c.sentAt ? dateTime(c.sentAt) : '—'}</td>
                    <td className="whitespace-nowrap text-fg-2">{c.doneAt ? dateTime(c.doneAt) : c.expiresAt && c.status === 'PENDING' ? <span className="text-xs text-fg-3">ističe {dateTime(c.expiresAt)}</span> : '—'}</td>
                    <td className={c.status === 'FAILED' ? 'max-w-80 text-sm text-bad-strong' : 'max-w-80 text-sm text-fg-2'}>
                      <span className="line-clamp-3 break-words" title={result ?? undefined}>{result ?? '—'}</span>
                    </td>
                    <td className="text-right">
                      {canOps && c.status === 'PENDING' && (
                        <ActionButton action={cancelCommandAction} input={{ id: c.id }} size="sm" variant="ghost" icon={<X className="size-4" />}>
                          Otkaži
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty icon={<Terminal className="size-5" />} title="Nema naredbi" description="Naredbe poslane uređaju (reboot, snimka zaslona, instalacija…) prikazuju se ovdje." />
        )}
      </TableWrap>
      <Pagination page={pg.page} pageSize={pg.pageSize} total={list.total} params={sp} basePath={`/mdm/uredaji/${d.id}/naredbe`} />
    </>
  );
}
