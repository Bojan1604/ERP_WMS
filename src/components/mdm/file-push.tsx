'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Empty } from '@/components/ui/misc';
import { PlatformIcon } from './common';

export interface PushTargets {
  devices: { id: string; name: string; platform: string; where: string }[];
  sites: { id: string; name: string; org: string; devices: number }[];
}

type PushInput = { fileId: string; deviceIds: string[]; siteId: string | null; targetPath: string | null };

/** „Pošalji na uređaje": naredba PUSH_FILE odabranim uređajima ili cijeloj lokaciji. */
export function FilePushButton({ file, targets, action }: { file: { id: string; name: string }; targets: PushTargets; action: ServerAction<PushInput> }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'devices' | 'site'>('devices');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [siteId, setSiteId] = useState('');
  const [target, setTarget] = useState('');
  const [q, setQ] = useState('');
  const { run, pending, error } = useAction(action, { onSuccess: () => setOpen(false) });
  const list = targets.devices.filter((d) => !q || `${d.name} ${d.where}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string) => {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setPicked(n);
  };
  const ready = mode === 'devices' ? picked.size > 0 : !!siteId;
  return (
    <>
      <Button size="sm" icon={<Send className="size-3.5" />} onClick={() => setOpen(true)}>
        Pošalji na uređaje
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Pošalji: ${file.name}`}
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!ready}
              onClick={() => run({ fileId: file.id, deviceIds: mode === 'devices' ? [...picked] : [], siteId: mode === 'site' ? siteId : null, targetPath: target || null })}
            >
              Pošalji
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormError error={error} />
          <div className="inline-flex rounded-md border border-line-strong p-0.5">
            {(['devices', 'site'] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`rounded px-3 py-1 text-sm ${mode === m ? 'bg-brand-soft font-medium text-brand' : 'text-fg-3'}`}>
                {m === 'devices' ? 'Odabrani uređaji' : 'Svi uređaji lokacije'}
              </button>
            ))}
          </div>
          {mode === 'devices' ? (
            <>
              <Input placeholder="Traži uređaj…" value={q} onChange={(e) => setQ(e.target.value)} />
              {list.length ? (
                <div className="max-h-72 divide-y divide-line overflow-y-auto scroll-slim rounded-lg border border-line">
                  {list.map((d) => (
                    <label key={d.id} className="flex cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-muted/60">
                      <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
                      <PlatformIcon platform={d.platform} />
                      <span className="font-medium">{d.name}</span>
                      <span className="text-sm text-fg-3">{d.where}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <Empty title="Nema upisanih uređaja" />
              )}
            </>
          ) : (
            <Field label="Lokacija">
              <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder="Odaberite…" options={targets.sites.map((s) => ({ value: s.id, label: `${s.org} › ${s.name} (${s.devices} ur.)` }))} />
            </Field>
          )}
          <Field label="Odredišna mapa na uređaju" hint={'Prazno = zadano: Android „Download/", Windows „C:\\ProgramData\\ERPWMS\\files\\".'}>
            <Input value={target} onChange={(e) => setTarget(e.target.value)} maxLength={260} className="font-mono" />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
