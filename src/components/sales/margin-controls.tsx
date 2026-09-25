'use client';

import { useState } from 'react';
import { Boxes, Package, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { Combobox } from '@/components/ui/combobox';
import { FormError, useAction } from '@/components/ui/action';
import { amount, pct } from '@/lib/format';
import { parseNumber } from '@/domain/money';
import { grossMargin } from '@/domain/pricing';
import { savePackageAction, setGlobalMarginAction, setModelMarginAction } from '@/app/(app)/prodaja/marze/actions';
import { DevicePicker } from './device-picker';
import type { DeviceOpt, ModelOpt, NamedOpt } from './types';

/** Globalna bruto marža s „Primijeni na sve" (briše marže po modelima i uređajima). */
export function GlobalMarginForm({ value }: { value: number }) {
  const [v, setV] = useState(String(value).replace('.', ','));
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState(true);
  const [items, setItems] = useState(true);
  const { run, pending, error } = useAction(setGlobalMarginAction);
  const pctNum = parseNumber(v);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-fg-3">Globalna bruto marža</span>
      <Input value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" className="w-20 text-right" aria-label="Globalna bruto marža %" />
      <span className="text-sm text-fg-3">%</span>
      <Button size="sm" loading={pending} onClick={() => run({ pct: pctNum, resetModels: false, resetItems: false })}>
        Spremi
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} title="Postavlja maržu i vraća pojedinačne marže modela i uređaja na globalnu">
        Primijeni na sve
      </Button>
      <FormError error={error} />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Globalna marža za sve"
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={async () => {
                const r = await run({ pct: pctNum, resetModels: models, resetItems: items });
                if (r.ok) setOpen(false);
              }}
            >
              Primijeni
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-base text-fg-2">
          <p>
            Zadana bruto marža postaje <b className="text-fg">{String(pctNum).replace('.', ',')} %</b>. Preporučena cijena = nabavna ÷ (1 − marža).
          </p>
          <Checkbox label="Vrati marže po modelima na globalnu" checked={models} onChange={(e) => setModels(e.target.checked)} />
          <Checkbox label="Vrati marže upisane na uređajima na globalnu" checked={items} onChange={(e) => setItems(e.target.checked)} />
          <FormError error={error} />
        </div>
      </Dialog>
    </div>
  );
}

/** Marža modela u tablici „Preporučene marže" (prazno = globalna); sprema se pri izlasku iz polja. */
export function ModelMarginInput({ modelId, value, global, disabled }: { modelId: string; value: number | null; global: number; disabled?: boolean }) {
  const [v, setV] = useState(value === null ? '' : String(value).replace('.', ','));
  const { run, pending } = useAction(setModelMarginAction);
  const save = () => {
    const next = v.trim() === '' ? null : parseNumber(v);
    if (next === value) return;
    void run({ modelId, pct: next });
  };
  return (
    <Input
      value={v}
      disabled={disabled || pending}
      placeholder={String(global).replace('.', ',')}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      inputMode="decimal"
      className="ml-auto h-7 w-20 text-right"
      aria-label="Bruto marža modela %"
    />
  );
}

/**
 * Novi paket: uređaji sa skladišta, ukupna nabavna, prijedlog cijene
 * (preporučene cijene), cijena paketa i marža; sprema se kao ponuda kupcu.
 */
export function PackageBuilder({
  partners,
  models,
  categories,
  warehouses,
}: {
  partners: Array<{ id: string; name: string }>;
  models: ModelOpt[];
  categories: NamedOpt[];
  warehouses: NamedOpt[];
}) {
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const [name, setName] = useState('');
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<DeviceOpt[]>([]);
  const { run, pending, error } = useAction(savePackageAction);
  const cost = items.reduce((a, d) => a + d.cost, 0);
  const suggested = items.reduce((a, d) => a + d.price, 0);
  const total = price.trim() ? parseNumber(price) : suggested;
  return (
    <>
      <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
        Paket
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Novi paket"
        size="lg"
        footer={
          <>
            <span className="mr-auto self-center text-sm text-fg-3">
              Nabavna {amount(cost)} · cijena {amount(total)} · bruto marža {pct(grossMargin(total, cost))}
            </span>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!name.trim() || !partnerId || !items.length}
              onClick={() => run({ partnerId: partnerId!, name, itemIds: items.map((d) => d.id), price: price.trim() ? parseNumber(price) : null, note: note || null })}
            >
              Spremi kao ponudu
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Naziv paketa" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="npr. Starter paket za bistro" />
          </Field>
          <Field label="Kupac" required>
            <Combobox options={partners.map((p) => ({ value: p.id, label: p.name }))} value={partnerId} onChange={setPartnerId} placeholder="Odaberite kupca…" />
          </Field>
          <Field label={`Cijena paketa € (prijedlog ${amount(suggested)})`}>
            <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder={amount(suggested)} inputMode="decimal" className="text-right" />
          </Field>
          <Field label="Napomena">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="mb-2 mt-4 flex items-center justify-between">
          <p className="font-medium">U paketu ({items.length})</p>
          <Button size="sm" icon={<Boxes className="size-3.5" />} onClick={() => setPicker(true)}>
            Dodaj sa skladišta
          </Button>
        </div>
        <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line scroll-slim">
          {items.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
              <span className="font-mono">{d.serial}</span>
              <span className="min-w-0 flex-1 truncate">{d.model}</span>
              <span className="tnum text-fg-3">{amount(d.cost)}</span>
              <span className="tnum">{amount(d.price)}</span>
              <button type="button" onClick={() => setItems((cur) => cur.filter((x) => x.id !== d.id))} className="rounded p-1 text-fg-3 hover:bg-bad-soft hover:text-bad-strong" aria-label={`Ukloni ${d.serial}`}>
                <X className="size-3.5" />
              </button>
            </li>
          ))}
          {!items.length && (
            <li className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-fg-3">
              <Package className="size-4" /> Dodajte uređaje sa skladišta.
            </li>
          )}
        </ul>
        <p className="mt-2 text-xs text-fg-3">Paket je informativan: sprema se kao ponuda (nacrt) s ovim uređajima; cijena paketa se raspoređuje razmjerno preporučenim cijenama.</p>
        <FormError error={error} />
      </Dialog>
      <DevicePicker
        open={picker}
        onClose={() => setPicker(false)}
        onPick={(ds) => setItems((cur) => [...cur, ...ds.filter((d) => !cur.some((x) => x.id === d.id))])}
        partnerId={partnerId}
        models={models}
        categories={categories}
        warehouses={warehouses}
        exclude={items.map((d) => d.id)}
      />
    </>
  );
}
