'use client';

import { useState } from 'react';
import { Boxes, FileText, Package, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { PartnerCombobox } from '@/components/partners/partner-combobox';
import { ActionButton, FormError, useAction } from '@/components/ui/action';
import { amount, pct } from '@/lib/format';
import { parseNumber } from '@/domain/money';
import { packageTotals } from '@/domain/pricing';
import { convertPackageAction, deletePackageAction, savePackageAction } from '@/app/(app)/prodaja/marze/actions';
import { DevicePicker } from './device-picker';
import type { ModelOpt, NamedOpt } from './types';

/** Uređaj u paketu (sa skladišta): nabavna i preporučena cijena. */
export interface PackageDevice {
  id: string;
  serial: string;
  model: string;
  cost: number;
  price: number;
}

export interface PackageValue {
  id: string;
  name: string;
  price: number | null;
  note: string | null;
  items: PackageDevice[];
}

interface Catalog {
  models: ModelOpt[];
  categories: NamedOpt[];
  warehouses: NamedOpt[];
}

/**
 * Novi paket ili izmjena: uređaji sa skladišta, ukupna nabavna, prijedlog cijene
 * (zbroj preporučenih), cijena paketa i bruto marža (orig. Margins.jsx PackageModal).
 */
export function PackageEditor({ initial, catalog }: { initial?: PackageValue; catalog: Catalog }) {
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const [name, setName] = useState(initial?.name ?? '');
  const [price, setPrice] = useState(initial?.price == null ? '' : String(initial.price).replace('.', ','));
  const [note, setNote] = useState(initial?.note ?? '');
  const [items, setItems] = useState<PackageDevice[]>(initial?.items ?? []);
  const { run, pending, error } = useAction(savePackageAction);
  const t = packageTotals(items, price.trim() ? parseNumber(price) : null);
  return (
    <>
      {initial ? (
        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setOpen(true)}>
          Uredi
        </Button>
      ) : (
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
          Paket
        </Button>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={initial ? 'Uredi paket' : 'Novi paket'}
        size="lg"
        footer={
          <>
            <span className="mr-auto self-center text-sm text-fg-3">
              Nabavna {amount(t.cost)} · cijena {amount(t.price)} · bruto marža {pct(t.margin)}
            </span>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!name.trim() || !items.length}
              onClick={async () => {
                const r = await run({ id: initial?.id ?? null, name, itemIds: items.map((d) => d.id), price: price.trim() ? parseNumber(price) : null, note: note || null });
                if (r.ok) {
                  setOpen(false);
                  if (!initial) {
                    setName('');
                    setPrice('');
                    setNote('');
                    setItems([]);
                  }
                }
              }}
            >
              Spremi
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Naziv paketa" required className="md:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="npr. Starter paket za bistro" maxLength={200} />
          </Field>
          <Field label={`Cijena paketa € (prijedlog ${amount(t.suggested)})`} hint="Prazno = zbroj preporučenih cijena">
            <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder={amount(t.suggested)} inputMode="decimal" className="text-right" />
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
              <span className="tnum text-fg-3" title="Nabavna">
                {amount(d.cost)}
              </span>
              <span className="tnum" title="Preporučena">
                {amount(d.price)}
              </span>
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
        <p className="mt-2 text-xs text-fg-3">Paket je informativan: iz njega se izrađuje ponuda, predračun ili nacrt računa za kupca; cijena paketa se raspoređuje razmjerno preporučenim cijenama.</p>
        <FormError error={error} />
      </Dialog>
      <DevicePicker
        open={picker}
        onClose={() => setPicker(false)}
        onPick={(ds) => setItems((cur) => [...cur, ...ds.filter((d) => !cur.some((x) => x.id === d.id)).map((d) => ({ id: d.id, serial: d.serial, model: d.model, cost: d.cost, price: d.price }))])}
        partnerId={null}
        models={catalog.models}
        categories={catalog.categories}
        warehouses={catalog.warehouses}
        exclude={items.map((d) => d.id)}
      />
    </>
  );
}

const TARGETS = [
  { value: 'QUOTE', label: 'Ponuda' },
  { value: 'PROFORMA', label: 'Predračun' },
  { value: 'INVOICE', label: 'Nacrt računa' },
] as const;

/** Paket → ponuda, predračun ili nacrt računa za odabranog kupca (cijene prema kupcu). */
export function PackageConvert({ id, disabled }: { id: string; disabled?: string | null }) {
  const [open, setOpen] = useState(false);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [target, setTarget] = useState<(typeof TARGETS)[number]['value']>('QUOTE');
  const { run, pending, error } = useAction(convertPackageAction);
  return (
    <>
      <Button size="sm" icon={<FileText className="size-3.5" />} onClick={() => setOpen(true)} disabled={!!disabled} title={disabled ?? 'Izradi ponudu, predračun ili račun iz paketa'}>
        Izradi…
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Dokument iz paketa"
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button variant="primary" loading={pending} disabled={!partnerId} onClick={() => run({ id, partnerId: partnerId!, target })}>
              Izradi
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Kupac" required>
            <PartnerCombobox role="customer" value={partnerId} onChange={(id) => setPartnerId(id)} placeholder="Odaberite kupca…" />
          </Field>
          <Field label="Dokument">
            <Select value={target} onChange={(e) => setTarget(e.target.value as typeof target)} options={TARGETS.map((t) => ({ value: t.value, label: t.label }))} />
          </Field>
          <p className="text-xs text-fg-3">Preporučene cijene uzimaju u obzir cjenik kupca; cijena paketa raspoređuje se na uređaje razmjerno njima.</p>
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}

export function PackageDelete({ id, name }: { id: string; name: string }) {
  return (
    <ActionButton action={deletePackageAction} input={{ id }} size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} confirm={`Obrisati paket „${name}"? Uređaji ostaju na skladištu.`} confirmLabel="Obriši" aria-label={`Obriši paket ${name}`} />
  );
}
