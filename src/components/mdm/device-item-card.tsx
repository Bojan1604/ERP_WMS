import Link from 'next/link';
import { Card } from '@/components/ui/misc';
import { Ago, DeviceStatusBadge, OnlineBadge, orgPath, PlatformIcon } from './common';

interface LinkedDevice {
  id: string;
  name: string;
  platform: string;
  status: string;
  lastSeenAt: Date | null;
  agentVersion: string | null;
  org: { name: string; parent: { name: string } | null } | null;
  site: { name: string } | null;
}

/** Kartica „MDM" na uređaju u skladištu — povezani MDM uređaj(i) sa stanjem veze. */
export function MdmItemCard({ devices }: { devices: LinkedDevice[] }) {
  if (!devices.length) return null;
  return (
    <Card title="MDM" padded={false}>
      <ul className="divide-y divide-line">
        {devices.map((d) => (
          <li key={d.id} className="px-4 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5">
                <PlatformIcon platform={d.platform} />
                <Link prefetch={false} href={`/mdm/uredaji/${d.id}`} className="link font-medium">
                  {d.name}
                </Link>
              </span>
              {d.status === 'ENROLLED' ? <OnlineBadge lastSeenAt={d.lastSeenAt} /> : <DeviceStatusBadge status={d.status} />}
            </div>
            <div className="mt-0.5 text-sm text-fg-3">
              {orgPath(d.org)}
              {d.site && ` › ${d.site.name}`} · javio se <Ago at={d.lastSeenAt} />
              {d.agentVersion && ` · agent ${d.agentVersion}`}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
