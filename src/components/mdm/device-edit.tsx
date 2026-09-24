'use client';

import { useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { useAction } from '@/components/ui/action';
import { updateDeviceAction } from '@/app/(app)/mdm/uredaji/actions';

/** Naziv uređaja u zaglavlju — uređuje se na mjestu (kao SCN). */
export function DeviceName({ id, name, canEdit }: { id: string; name: string; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(name);
  const { run, pending } = useAction(updateDeviceAction);
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {name}
        {canEdit && (
          <button type="button" onClick={() => { setV(name); setEditing(true); }} className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-muted hover:text-fg" aria-label="Preimenuj">
            <Pencil className="size-3.5" />
          </button>
        )}
      </span>
    );
  }
  const save = async () => {
    if (v.trim() === name) return setEditing(false);
    const r = await run({ id, name: v });
    if (r.ok) setEditing(false);
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        value={v}
        onChange={(e) => setV(e.target.value)}
        maxLength={100}
        autoFocus
        className="h-9 w-72 max-w-[60vw] text-lg"
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <Button size="sm" variant="primary" loading={pending} onClick={save} icon={<Check className="size-4" />} aria-label="Spremi" />
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)} icon={<X className="size-4" />} aria-label="Odustani" />
    </span>
  );
}

/** Bilješke uz uređaj (kao „Notes" u SCN-u). */
export function DeviceNotes({ id, notes, canEdit }: { id: string; notes: string | null; canEdit: boolean }) {
  const [v, setV] = useState(notes ?? '');
  const { run, pending } = useAction(updateDeviceAction, { successMessage: 'Bilješka spremljena.' });
  const dirty = v !== (notes ?? '');
  return (
    <div className="space-y-2">
      <Textarea value={v} onChange={(e) => setV(e.target.value)} rows={4} placeholder="Upišite bilješku…" disabled={!canEdit} maxLength={5000} />
      {canEdit && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-3">{dirty ? 'Nije spremljeno' : 'Spremljeno'}</span>
          <Button size="sm" variant="primary" disabled={!dirty} loading={pending} onClick={() => run({ id, notes: v })}>
            Spremi
          </Button>
        </div>
      )}
    </div>
  );
}

/** Servisni PIN za izlaz iz zaključanog načina na uređaju. */
export function DevicePin({ id, pin, canEdit }: { id: string; pin: string | null; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [show, setShow] = useState(false);
  const [v, setV] = useState(pin ?? '');
  const { run, pending } = useAction(updateDeviceAction, { successMessage: 'PIN spremljen — uređaj ga dobiva s konfiguracijom.' });
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2">
        {pin ? (
          <button type="button" className="font-mono tnum" onClick={() => setShow((s) => !s)} title="Prikaži / sakrij">
            {show ? pin : '••••'}
          </button>
        ) : (
          <span className="text-fg-4">nije postavljen</span>
        )}
        {canEdit && (
          <button type="button" onClick={() => { setV(pin ?? ''); setEditing(true); }} className="text-sm link">
            {pin ? 'promijeni' : 'postavi'}
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={8} placeholder="4–8 znamenki" className="w-32 font-mono" autoFocus />
      <Button
        size="sm"
        variant="primary"
        loading={pending}
        onClick={async () => {
          const r = await run({ id, maintenancePin: v || null });
          if (r.ok) setEditing(false);
        }}
      >
        Spremi
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Odustani
      </Button>
    </span>
  );
}
