'use client';

import { useState } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActionButton, useAction, type ServerAction } from '@/components/ui/action';
import { Badge, Empty, Notice, type Tone } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { AddAppDialog } from './config-apps';
import type { LibraryApp } from './config-model';

export type AppState = 'INSTALLED' | 'OUTDATED' | 'MISSING' | 'REMOVE' | 'EXTRA';

export interface DeviceAppRow {
  packageName: string;
  name: string;
  installed: string | null;
  installedCode: number | null;
  expected: string | null;
  state: AppState;
  appId: string | null;
  versionId: string | null;
  managed: boolean;
}

const STATE: Record<AppState, { label: string; tone: Tone }> = {
  MISSING: { label: 'za instalaciju', tone: 'warn' },
  OUTDATED: { label: 'zastarjela', tone: 'warn' },
  REMOVE: { label: 'za uklanjanje', tone: 'bad' },
  INSTALLED: { label: 'instalirana', tone: 'ok' },
  EXTRA: { label: 'izvan konfiguracije', tone: 'neutral' },
};

/** Aplikacije na uređaju prema zadnjem javljanju, uspoređene s konfiguracijom. */
export function DeviceApps({
  device,
  rows,
  library,
  pending,
  canEdit,
  install,
  uninstall,
}: {
  device: { id: string; platform: string; status: string; hasTelemetry: boolean };
  rows: DeviceAppRow[];
  library: LibraryApp[];
  pending: { type: string; packageName: string; status: string }[];
  canEdit: boolean;
  install: ServerAction<{ deviceId: string; appId: string; versionId: string | null }>;
  uninstall: ServerAction<{ deviceId: string; packageName: string; name: string | null }>;
}) {
  const [filter, setFilter] = useState<'all' | 'managed' | 'problems' | 'extra'>('all');
  const [adding, setAdding] = useState(false);
  const inst = useAction(install, { onSuccess: () => setAdding(false) });
  const enrolled = device.status === 'ENROLLED';
  const list = rows.filter((r) =>
    filter === 'managed' ? r.managed : filter === 'problems' ? ['MISSING', 'OUTDATED', 'REMOVE'].includes(r.state) : filter === 'extra' ? r.state === 'EXTRA' : true,
  );
  const problems = rows.filter((r) => ['MISSING', 'OUTDATED', 'REMOVE'].includes(r.state)).length;
  const waiting = (pkg: string) => pending.find((p) => p.packageName === pkg);

  return (
    <div className="space-y-3">
      {!device.hasTelemetry && <Notice tone="neutral">Uređaj još nije poslao popis instaliranih aplikacija — prikazuje se samo ono što konfiguracija traži.</Notice>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedLocal
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `Sve (${rows.length})` },
            { value: 'managed', label: 'Iz konfiguracije' },
            { value: 'problems', label: `Odstupanja (${problems})` },
            { value: 'extra', label: 'Ostale' },
          ]}
        />
        {canEdit && enrolled && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Instaliraj aplikaciju
          </Button>
        )}
      </div>
      <div className="overflow-x-auto scroll-slim rounded-lg bg-panel shadow-[var(--shadow-panel)]">
        {list.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Aplikacija</th>
                <th>Paket</th>
                <th>Instalirano</th>
                <th>Konfiguracija</th>
                <th>Stanje</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const w = waiting(r.packageName);
                const canInstall = canEdit && enrolled && r.appId && (r.state === 'MISSING' || r.state === 'OUTDATED' || (r.state === 'EXTRA' && r.appId));
                return (
                  <tr key={r.packageName}>
                    <td className="font-medium">{r.name}</td>
                    <td className="font-mono text-sm">{r.packageName}</td>
                    <td className="tnum">{r.installed ?? <span className="text-fg-4">—</span>}</td>
                    <td className="tnum">{r.expected ?? <span className="text-fg-4">—</span>}</td>
                    <td className="whitespace-nowrap">
                      <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>
                      {w && (
                        <Badge tone="info" className="ml-1">
                          {w.type === 'INSTALL_APP' ? 'instalacija' : 'uklanjanje'} čeka
                        </Badge>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {canInstall && (
                        <ActionButton size="sm" action={install} input={{ deviceId: device.id, appId: r.appId!, versionId: r.managed ? r.versionId : null }} icon={<Download className="size-3.5" />}>
                          {r.state === 'MISSING' ? 'Instaliraj' : 'Ažuriraj'}
                        </ActionButton>
                      )}
                      {canEdit && enrolled && r.installed !== null && (
                        <ActionButton
                          size="sm"
                          variant="ghost"
                          action={uninstall}
                          input={{ deviceId: device.id, packageName: r.packageName, name: r.name }}
                          icon={<Trash2 className="size-3.5" />}
                          confirm={
                            <>
                              Ukloniti „{r.name}" s uređaja?
                              {r.managed && !(r.state === 'REMOVE') && <p className="mt-2 text-sm text-warn">Aplikacija je u konfiguraciji — agent će je ponovno instalirati. Za trajno uklanjanje označite „ukloni" u konfiguraciji.</p>}
                            </>
                          }
                          confirmLabel="Ukloni"
                          title="Ukloni s uređaja"
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty title="Nema aplikacija" description="Za odabrani filtar nema aplikacija." />
        )}
      </div>
      <AddAppDialog
        open={adding}
        onClose={() => setAdding(false)}
        library={library}
        title="Instaliraj aplikaciju"
        pickLabel="Instaliraj"
        onPick={(appId, versionId) => inst.run({ deviceId: device.id, appId, versionId })}
      />
    </div>
  );
}

/** Segmentni odabir bez URL-a (filtar unutar već učitanog popisa). */
function SegmentedLocal<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-md border border-line-strong bg-panel p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} className={cn('rounded px-2.5 py-1 text-sm', value === o.value ? 'bg-brand-soft font-medium text-brand' : 'text-fg-3 hover:text-fg')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
