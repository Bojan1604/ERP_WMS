'use client';

import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormGrid, Input, Textarea } from '@/components/ui/field';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { PartnerCombobox } from '@/components/partners/partner-combobox';
import type { PartnerOpt } from '@/lib/partner-option';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Card } from '@/components/ui/misc';
import { eur } from '@/lib/format';
import { r2 } from '@/domain/money';

export interface OrderFormLine {
  id?: string | null;
  modelId: string;
  qty: number;
  unitCost: number;
  received?: number;
}

export interface OrderFormValue {
  id?: string | null;
  supplierId: string | null;
  date: string;
  expectedDate: string | null;
  note: string | null;
  lines: OrderFormLine[];
}

interface SaveInput {
  id: string | null;
  supplierId: string;
  date: string;
  expectedDate: string | null;
  note: string | null;
  lines: Array<{ id: string | null; modelId: string; qty: number; unitCost: number }>;
}

/** Zaglavlje i stavke narudžbenice (novi unos i izmjena). */
export function OrderForm({
  initial,
  supplier,
  models,
  action,
  cancelHref,
}: {
  initial: OrderFormValue;
  /** Trenutni dobavljač (ostali se traže pretragom na poslužitelju). */
  supplier: PartnerOpt | null;
  models: Array<ComboOption & { cost?: number }>;
  action: ServerAction<SaveInput>;
  cancelHref: string;
}) {
  const [v, setV] = useState(initial);
  const { run, pending, error } = useAction(action);
  const total = useMemo(() => r2(v.lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0)), [v.lines]);
  const setLine = (i: number, patch: Partial<OrderFormLine>) => setV((s) => ({ ...s, lines: s.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) }));

  const [localError, setLocalError] = useState<string | null>(null);
  const submit = () => {
    if (!v.supplierId) return setLocalError('Odaberite dobavljača.');
    if (!v.lines.some((l) => l.modelId)) return setLocalError('Dodajte barem jednu stavku s modelom.');
    setLocalError(null);
    run({
      id: v.id ?? null,
      supplierId: v.supplierId,
      date: v.date,
      expectedDate: v.expectedDate || null,
      note: v.note || null,
      lines: v.lines.filter((l) => l.modelId).map((l) => ({ id: l.id ?? null, modelId: l.modelId, qty: Number(l.qty), unitCost: Number(l.unitCost) })),
    });
  };

  return (
    <div className="space-y-4">
      <Card title="Zaglavlje">
        <FormGrid cols={4}>
          <Field label="Dobavljač" required className="sm:col-span-2">
            <PartnerCombobox role="supplier" initial={supplier} value={v.supplierId} onChange={(id) => setV((s) => ({ ...s, supplierId: id }))} placeholder="Odaberite dobavljača…" />
          </Field>
          <Field label="Datum" required>
            <Input type="date" value={v.date} onChange={(e) => setV((s) => ({ ...s, date: e.target.value }))} />
          </Field>
          <Field label="Očekivana isporuka">
            <Input type="date" value={v.expectedDate ?? ''} onChange={(e) => setV((s) => ({ ...s, expectedDate: e.target.value || null }))} />
          </Field>
          <Field label="Napomena" className="sm:col-span-4">
            <Textarea rows={2} value={v.note ?? ''} onChange={(e) => setV((s) => ({ ...s, note: e.target.value }))} />
          </Field>
        </FormGrid>
      </Card>

      <Card title="Stavke" padded={false}>
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-8">#</th>
              <th>Model</th>
              <th className="num w-28">Količina</th>
              <th className="num w-36">Nabavna cijena</th>
              <th className="num w-28">Zaprimljeno</th>
              <th className="num w-32">Iznos</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {v.lines.map((l, i) => {
              const locked = (l.received ?? 0) > 0;
              return (
                <tr key={l.id ?? `n${i}`}>
                  <td className="text-fg-3">
                    <span className="sm:hidden">Stavka </span>
                    {i + 1}
                  </td>
                  <td className="min-w-72 max-sm:col-span-2 max-sm:min-w-0">
                    <Combobox
                      options={models}
                      value={l.modelId || null}
                      disabled={locked}
                      onChange={(id, o) => {
                        const m = models.find((x) => x.value === id) ?? (o as (typeof models)[number] | undefined);
                        setLine(i, { modelId: id ?? '', ...(m?.cost && !l.unitCost ? { unitCost: m.cost } : {}) });
                      }}
                      placeholder="Odaberite model…"
                    />
                  </td>
                  <td>
                    <Input type="number" min={Math.max(1, l.received ?? 0)} step={1} value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} />
                  </td>
                  <td>
                    <Input type="number" min={0} step="0.01" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: Number(e.target.value) })} />
                  </td>
                  <td className="num text-fg-3">{l.received ?? 0}</td>
                  <td className="num">{eur(r2((Number(l.qty) || 0) * (Number(l.unitCost) || 0)))}</td>
                  <td className="max-sm:absolute max-sm:right-2 max-sm:top-1.5">
                    <button
                      type="button"
                      disabled={locked}
                      title={locked ? 'Stavka je djelomično zaprimljena' : 'Ukloni stavku'}
                      onClick={() => setV((s) => ({ ...s, lines: s.lines.filter((_, k) => k !== i) }))}
                      className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-muted hover:text-bad-strong disabled:opacity-30"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="max-sm:[&>td]:before:hidden">
              <td colSpan={2} className="max-sm:col-span-2">
                <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setV((s) => ({ ...s, lines: [...s.lines, { modelId: '', qty: 1, unitCost: 0 }] }))}>
                  Dodaj stavku
                </Button>
              </td>
              <td className="num max-sm:col-span-2">{v.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0)} kom</td>
              <td colSpan={2} className="num">
                Ukupno bez PDV-a
              </td>
              <td className="num">{eur(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </Card>

      <FormError error={localError ?? error} />
      {/* na mobitelu traka za spremanje ostaje pri dnu ekrana, iznad donjeg izbornika */}
      <div className="flex justify-end gap-2 max-lg:sticky max-lg:bottom-[calc(3.75rem+env(safe-area-inset-bottom))] max-lg:z-30 max-lg:-mx-3 max-lg:border-t max-lg:border-line max-lg:bg-panel/95 max-lg:px-3 max-lg:py-2.5 max-lg:backdrop-blur sm:max-lg:-mx-5 sm:max-lg:px-5">
        <LinkButton href={cancelHref}>Odustani</LinkButton>
        <Button variant="primary" loading={pending} onClick={submit} className="max-sm:flex-1">
          Spremi narudžbenicu
        </Button>
      </div>
    </div>
  );
}
