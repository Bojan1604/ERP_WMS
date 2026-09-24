'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { Badge, Empty } from '@/components/ui/misc';
import { useAction, type ServerAction } from '@/components/ui/action';

export interface SiteOption {
  id: string;
  name: string;
  org: string;
  devices: number;
  /** Uređaji druge platforme na lokaciji. */
  otherPlatform: number;
  assigned: boolean;
  /** Lokacija trenutno ima drugu konfiguraciju. */
  otherProfile: string | null;
}

/** „Dodijeli lokacijama": odabrane lokacije dobivaju ovu konfiguraciju, ostale je gube. */
export function ProfileSites({
  open,
  onClose,
  profileId,
  sites,
  action,
}: {
  open: boolean;
  onClose: () => void;
  profileId: string;
  sites: SiteOption[];
  action: ServerAction<{ profileId: string; siteIds: string[] }>;
}) {
  const [picked, setPicked] = useState(() => new Set(sites.filter((s) => s.assigned).map((s) => s.id)));
  const [q, setQ] = useState('');
  const { run, pending } = useAction(action, { onSuccess: onClose });
  const list = useMemo(() => sites.filter((s) => !q || `${s.org} ${s.name}`.toLowerCase().includes(q.toLowerCase())), [sites, q]);
  const toggle = (id: string) => {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setPicked(n);
  };
  const devices = sites.filter((s) => picked.has(s.id)).reduce((a, s) => a + s.devices, 0);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Dodijeli lokacijama"
      size="lg"
      footer={
        <>
          <span className="mr-auto self-center text-sm text-fg-3">
            Odabrano {picked.size} lokacija · {devices} uređaja
          </span>
          <Button onClick={onClose}>Odustani</Button>
          <Button variant="primary" loading={pending} onClick={() => run({ profileId, siteIds: [...picked] })}>
            Spremi
          </Button>
        </>
      }
    >
      <p className="mb-2 text-sm text-fg-3">Uređaji na lokaciji koriste njenu konfiguraciju, osim ako uređaj ima vlastitu. Lokacija s drugom konfiguracijom prelazi na ovu.</p>
      <Input placeholder="Traži lokaciju ili organizaciju…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-2" />
      {list.length ? (
        <div className="max-h-[50vh] divide-y divide-line overflow-y-auto scroll-slim rounded-lg border border-line">
          {list.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/60">
              <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{s.name}</span>
                <span className="ml-2 text-sm text-fg-3">{s.org}</span>
              </span>
              {s.otherProfile && !picked.has(s.id) && <Badge tone="neutral">{s.otherProfile}</Badge>}
              {s.otherProfile && picked.has(s.id) && <Badge tone="warn">zamjenjuje „{s.otherProfile}"</Badge>}
              {s.otherPlatform > 0 && (
                <Badge tone="warn" title="Lokacija ima jednu konfiguraciju; uređaji druge platforme trebaju vlastitu konfiguraciju (kartica Konfiguracija na uređaju).">
                  +{s.otherPlatform} druge platforme
                </Badge>
              )}
              <span className="text-sm text-fg-3 tnum">{s.devices} ur.</span>
            </label>
          ))}
        </div>
      ) : (
        <Empty title="Nema lokacija" description="Lokacije se dodaju u organizacijama (Distributeri i klijenti)." />
      )}
    </Dialog>
  );
}
