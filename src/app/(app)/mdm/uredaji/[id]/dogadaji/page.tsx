import { notFound } from 'next/navigation';
import { History } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { deviceEvents, getDevice } from '@/server/queries/mdm';
import { Badge, Card, Empty } from '@/components/ui/misc';
import { FilterBar, SegmentFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { EVENT_LEVEL_TONE } from '@/components/mdm/common';
import { dateTime } from '@/lib/format';

export const metadata = { title: 'Događaji uređaja' };

type Params = Record<string, string | string[] | undefined>;
const LEVELS: Record<string, string> = { info: 'Info', warn: 'Upozorenje', error: 'Greška' };

export default async function DeviceEventsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const { id } = await params;
  const sp = await searchParams;
  const d = await getDevice(scope, id);
  if (!d) notFound();
  const level = typeof sp.level === 'string' && sp.level in LEVELS ? sp.level : null;
  const pg = readPage(sp, 100);
  const list = await deviceEvents(d.id, level, pg);

  return (
    <>
      <FilterBar>
        <SegmentFilter name="level" options={[{ value: '', label: 'Sve' }, ...Object.entries(LEVELS).map(([value, label]) => ({ value, label }))]} />
      </FilterBar>
      <Card padded={false}>
        {list.rows.length ? (
          <ol className="divide-y divide-line">
            {list.rows.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2">
                <span className="w-36 shrink-0 whitespace-nowrap text-sm text-fg-3 tnum">{dateTime(e.at)}</span>
                <Badge tone={EVENT_LEVEL_TONE[e.level] ?? 'neutral'}>{e.type}</Badge>
                <span className="min-w-0 flex-1 break-words text-base">{e.message}</span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty icon={<History className="size-5" />} title="Nema događaja" description="Upis, naredbe, promjene konfiguracije i zapisi agenta prikazuju se ovdje." />
        )}
      </Card>
      <Pagination page={pg.page} pageSize={pg.pageSize} total={list.total} params={sp} basePath={`/mdm/uredaji/${d.id}/dogadaji`} />
    </>
  );
}
