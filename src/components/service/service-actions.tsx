'use client';

import { useState } from 'react';
import { ArrowRightLeft, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';
import { cn } from '@/lib/cn';
import { DevicePicker, type DeviceSearch } from './device-picker';
import { SERVICE_STATUS, type ServiceStatusCode } from './labels';

type Settable = Exclude<ServiceStatusCode, 'REPLACED'>;
const FLOW: Settable[] = ['REPORTED', 'RECEIVED', 'DIAGNOSIS', 'AT_SUPPLIER', 'REPAIRED', 'WRITTEN_OFF'];

/** Promjena statusa naloga s napomenom koja ide u tijek. */
export function StatusControl({
  id,
  current,
  hasItem,
  action,
}: {
  id: string;
  current: ServiceStatusCode;
  hasItem: boolean;
  action: ServerAction<{ id: string; status: Settable; note: string | null; writeOffDevice: boolean }>;
}) {
  const [target, setTarget] = useState<Settable | null>(null);
  const [note, setNote] = useState('');
  const [writeOff, setWriteOff] = useState(false);
  const { run, pending, error } = useAction(action, {
    onSuccess: () => {
      setTarget(null);
      setNote('');
    },
  });
  if (current === 'REPLACED') return <p className="text-sm text-fg-3">Nalog je zatvoren zamjenom uređaja.</p>;
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {FLOW.map((s) => (
          <button
            key={s}
            type="button"
            disabled={s === current}
            onClick={() => setTarget(s)}
            className={cn(
              'h-7 rounded-md border px-2.5 text-sm transition-colors',
              s === current ? 'border-brand bg-brand-soft font-medium text-brand' : 'border-line-strong bg-panel text-fg-2 hover:bg-muted',
            )}
          >
            {SERVICE_STATUS[s].label}
          </button>
        ))}
      </div>
      <Dialog
        open={!!target}
        onClose={() => setTarget(null)}
        title={target ? `Status: ${SERVICE_STATUS[target].label}` : ''}
        size="sm"
        footer={
          <>
            <Button onClick={() => setTarget(null)}>Odustani</Button>
            <Button variant="primary" loading={pending} onClick={() => target && run({ id, status: target, note: note || null, writeOffDevice: writeOff })}>
              Promijeni status
            </Button>
          </>
        }
      >
        <Field label="Napomena u tijeku naloga">
          <Input value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="npr. poslano dobavljaču kurirskom službom" />
        </Field>
        {target === 'WRITTEN_OFF' && hasItem && (
          <Checkbox className="mt-3" label={`Otpiši i uređaj (status „Otpisan")`} checked={writeOff} onChange={(e) => setWriteOff(e.target.checked)} />
        )}
        <div className="mt-3">
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}

/** Povrat popravljenog uređaja: kupcu, u najam ili na skladište. */
export function ReturnDialog({
  id,
  options,
  defaultTarget,
  warehouses,
  defaultWarehouseId,
  action,
}: {
  id: string;
  options: Array<{ value: 'SOLD' | 'RENTED' | 'IN_STOCK'; label: string }>;
  defaultTarget: 'SOLD' | 'RENTED' | 'IN_STOCK';
  warehouses: Array<{ value: string; label: string }>;
  defaultWarehouseId: string | null;
  action: ServerAction<{ id: string; target: 'SOLD' | 'RENTED' | 'IN_STOCK'; warehouseId: string | null }>;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(defaultTarget);
  const [wh, setWh] = useState(defaultWarehouseId ?? warehouses[0]?.value ?? '');
  const { run, pending, error } = useAction(action, { onSuccess: () => setOpen(false) });
  return (
    <>
      <Button variant="primary" icon={<Undo2 className="size-4" />} onClick={() => setOpen(true)} className="w-full">
        Vrati uređaj
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Vrati popravljeni uređaj"
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button variant="primary" loading={pending} onClick={() => run({ id, target, warehouseId: target === 'IN_STOCK' ? wh : null })}>
              Vrati
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          {options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2">
              <input type="radio" name="target" checked={target === o.value} onChange={() => setTarget(o.value)} className="accent-[var(--color-brand)]" />
              {o.label}
            </label>
          ))}
        </div>
        {target === 'IN_STOCK' && (
          <Field label="Skladište" className="mt-3">
            <Select options={warehouses} value={wh} onChange={(e) => setWh(e.target.value)} />
          </Field>
        )}
        <div className="mt-3">
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}

/** Zamjenski uređaj sa skladišta preuzima mjesto izvornog kod klijenta. */
export function ReplaceDialog({
  id,
  itemId,
  search,
  warehouses,
  kindLabel,
  action,
}: {
  id: string;
  itemId: string;
  search: DeviceSearch;
  warehouses: Array<{ value: string; label: string }>;
  kindLabel: string;
  action: ServerAction<{ id: string; replacementId: string; originalTo: 'WRITTEN_OFF' | 'IN_STOCK'; warehouseId: string | null; note: string | null }>;
}) {
  const [open, setOpen] = useState(false);
  const [repl, setRepl] = useState<string | null>(null);
  const [originalTo, setOriginalTo] = useState<'WRITTEN_OFF' | 'IN_STOCK'>('WRITTEN_OFF');
  const [wh, setWh] = useState(warehouses[0]?.value ?? '');
  const [note, setNote] = useState('');
  const { run, pending, error } = useAction(action, { onSuccess: () => setOpen(false) });
  return (
    <>
      <Button icon={<ArrowRightLeft className="size-4" />} onClick={() => setOpen(true)} className="w-full">
        Zamjenski uređaj
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Zamjenski uređaj"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!repl}
              onClick={() => repl && run({ id, replacementId: repl, originalTo, warehouseId: originalTo === 'IN_STOCK' ? wh : null, note: note || null })}
            >
              Zamijeni
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Uređaj sa skladišta" required hint={`Preuzima klijenta, status (${kindLabel}), jamstvo i mjesto na ugovoru izvornog uređaja.`}>
            <DevicePicker search={search} value={repl} onChange={(v) => setRepl(v)} stockOnly excludeId={itemId} placeholder="Serijski broj ili model na skladištu…" />
          </Field>
          <Field label="Izvorni uređaj">
            <Select
              value={originalTo}
              onChange={(e) => setOriginalTo(e.target.value as 'WRITTEN_OFF' | 'IN_STOCK')}
              options={[
                { value: 'WRITTEN_OFF', label: 'Otpiši' },
                { value: 'IN_STOCK', label: 'Vrati na skladište' },
              ]}
            />
          </Field>
          {originalTo === 'IN_STOCK' && (
            <Field label="Skladište">
              <Select options={warehouses} value={wh} onChange={(e) => setWh(e.target.value)} />
            </Field>
          )}
          <Field label="Napomena">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}
