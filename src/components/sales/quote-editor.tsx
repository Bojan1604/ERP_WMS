'use client';

import { useMemo, useState } from 'react';
import { Boxes, Info, Layers, PenLine, Save, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, Badge, Notice } from '@/components/ui/misc';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import { Combobox } from '@/components/ui/combobox';
import { useAction } from '@/components/ui/action';
import { useToast } from '@/components/ui/toast';
import { eur } from '@/lib/format';
import { documentTotals } from '@/domain/invoice';
import { customerVat } from '@/domain/tax';
import { addDays } from '@/domain/dates';
import { modelQuotePrice, saveQuoteAction } from '@/app/(app)/prodaja/ponude/actions';
import { DevicePicker } from './device-picker';
import { CatalogPicker } from './catalog-picker';
import { LinesTable } from './lines-table';
import { TaxFields } from './invoice-tax-fields';
import { TotalsBox } from './totals-box';
import { lineKey } from './inputs';
import { modelName, type EditorLine, type SalesLookups } from './types';

export interface QuoteEditorValue {
  id: string | null;
  partnerId: string | null;
  date: string;
  validUntil: string;
  vatRate: number;
  discountPct: number;
  discountAmount: number;
  hideSerials: boolean;
  note: string;
  lines: EditorLine[];
}

/** Editor ponude: stavke po modelu (bez serijskih), konkretni uređaji, usluge i ručne stavke. */
export function QuoteEditor({ initial, lookups, stock: initialStock }: { initial: QuoteEditorValue; lookups: SalesLookups; stock: Record<string, number> }) {
  const { partners, services, models, company } = lookups;
  const [v, setV] = useState<QuoteEditorValue>(initial);
  const [stock, setStock] = useState(initialStock);
  const [picker, setPicker] = useState<'devices' | 'services' | 'models' | null>(null);
  const [validTouched, setValidTouched] = useState(!!initial.id);
  const { run, pending } = useAction(saveQuoteAction);
  const price = useAction(modelQuotePrice, { refresh: false });
  const toast = useToast();
  const set = (patch: Partial<QuoteEditorValue>) => setV((cur) => ({ ...cur, ...patch }));

  const partner = partners.find((p) => p.id === v.partnerId) ?? null;
  const treatment = partner ? customerVat(partner.country, company) : null;
  const totals = useMemo(
    () => documentTotals({ lines: v.lines, vatRate: v.vatRate, discountPct: v.discountPct, discountAmount: v.discountAmount }),
    [v.lines, v.vatRate, v.discountPct, v.discountAmount],
  );

  const choosePartner = (id: string | null) => {
    const p = partners.find((x) => x.id === id);
    if (!p) return set({ partnerId: null });
    set({ partnerId: p.id, vatRate: customerVat(p.country, company).rate });
  };

  const addModel = async (modelId: string) => {
    const m = models.find((x) => x.id === modelId);
    if (!m) return;
    const res = await price.run({ modelId, partnerId: v.partnerId });
    if (!res.ok || !res.data) return;
    const d = res.data;
    setStock((s) => ({ ...s, [modelId]: d.stock }));
    setV((cur) => ({
      ...cur,
      lines: [
        ...cur.lines,
        { key: lineKey(), kind: 'MODEL', modelId, description: modelName(m), unit: 'kom', kpd: '', qty: 1, unitPrice: d.price, discountPct: 0, warrantyMonths: null, agreedPrice: d.source === 'agreed' },
      ],
    }));
    toast('ok', `Dodano: ${modelName(m)}`);
  };
  const addService = (id: string) => {
    const s = services.find((x) => x.id === id);
    if (!s) return;
    setV((cur) => ({
      ...cur,
      lines: [...cur.lines, { key: lineKey(), kind: 'SERVICE', serviceId: s.id, description: s.name, unit: s.unit, kpd: '', qty: 1, unitPrice: s.price, discountPct: 0, warrantyMonths: null, agreedPrice: false }],
    }));
  };

  const save = () =>
    run({
      ...v,
      lines: v.lines.map((l) => ({
        kind: l.kind,
        itemId: l.itemId ?? null,
        modelId: l.modelId ?? null,
        serviceId: l.serviceId ?? null,
        description: l.description,
        unit: l.unit,
        qty: l.qty,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
      })),
    });

  return (
    <div>
      {partner?.note && (
        <Notice tone="warn">
          <span className="inline-flex items-start gap-2">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              <b>Napomena o partneru:</b> {partner.note}
            </span>
          </span>
        </Notice>
      )}
      <Card title="Kupac i rok" className="mb-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Field label="Kupac" required className="md:col-span-2">
            <Combobox
              options={partners.map((p) => ({ value: p.id, label: p.name, hint: [p.city, p.country !== 'HR' ? p.country : null].filter(Boolean).join(', ') }))}
              value={v.partnerId}
              onChange={choosePartner}
              placeholder="Odaberite kupca…"
            />
          </Field>
          <Field label="Datum ponude" required>
            <Input
              type="date"
              value={v.date}
              onChange={(e) => set({ date: e.target.value, ...(validTouched || !e.target.value ? {} : { validUntil: addDays(e.target.value, company.quoteValidDays) }) })}
            />
          </Field>
          <Field label="Vrijedi do" hint={`Zadano ${company.quoteValidDays} dana`}>
            <Input
              type="date"
              value={v.validUntil}
              onChange={(e) => {
                setValidTouched(true);
                set({ validUntil: e.target.value });
              }}
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <Checkbox label="Ispis bez serijskih brojeva (iste stavke se spajaju)" checked={v.hideSerials} onChange={(e) => set({ hideSerials: e.target.checked })} />
          {treatment && (
            <span className="flex items-center gap-2 text-sm text-fg-3">
              Porezni tretman: <Badge tone={treatment.category === 'S' ? 'brand' : 'info'}>{treatment.label}</Badge>
            </span>
          )}
        </div>
      </Card>

      <Card
        title="Stavke"
        padded={false}
        className="mb-4"
        actions={
          <>
            <Button size="sm" variant="subtle" icon={<Layers className="size-3.5" />} onClick={() => setPicker('models')} loading={price.pending}>
              Model (bez serijskih)
            </Button>
            <Button size="sm" icon={<Boxes className="size-3.5" />} onClick={() => setPicker('devices')}>
              Uređaji sa skladišta
            </Button>
            <Button size="sm" icon={<Wrench className="size-3.5" />} onClick={() => setPicker('services')}>
              Usluga
            </Button>
            <Button
              size="sm"
              icon={<PenLine className="size-3.5" />}
              onClick={() =>
                set({ lines: [...v.lines, { key: lineKey(), kind: 'MANUAL', description: '', unit: 'kom', kpd: '', qty: 1, unitPrice: 0, discountPct: 0, warrantyMonths: null, agreedPrice: false }] })
              }
            >
              Ručna stavka
            </Button>
          </>
        }
      >
        <LinesTable lines={v.lines} onChange={(lines) => set({ lines })} mode="quote" stock={stock} />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_22rem]">
        <Card title="Popust, PDV i napomena">
          <TaxFields v={v} set={(p) => set(p as Partial<QuoteEditorValue>)} showCharges={false} />
          <Field label="Napomena (ispisuje se na ponudi)" className="mt-3">
            <Textarea value={v.note} onChange={(e) => set({ note: e.target.value })} rows={3} />
          </Field>
        </Card>
        <Card title="Zbroj">
          <TotalsBox t={totals} vatRate={v.vatRate} />
        </Card>
      </div>

      <div className="no-print sticky bottom-0 z-30 -mx-4 -mb-4 mt-4 border-t border-line bg-panel/95 px-4 py-2.5 backdrop-blur sm:-mx-5 sm:-mb-5 sm:px-5">
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-sm text-fg-3">
            {v.lines.length} stavki · ukupno <b className="text-fg tnum">{eur(totals.total)}</b>
          </span>
          <Button variant="primary" icon={<Save className="size-4" />} loading={pending} disabled={!v.partnerId || !v.lines.length} onClick={save}>
            Spremi ponudu
          </Button>
        </div>
      </div>

      <DevicePicker
        open={picker === 'devices'}
        onClose={() => setPicker(null)}
        onPick={(ds) =>
          set({
            lines: [
              ...v.lines,
              ...ds.map((d): EditorLine => ({
                key: lineKey(),
                kind: 'DEVICE',
                itemId: d.id,
                modelId: d.modelId,
                description: d.model,
                unit: 'kom',
                kpd: '',
                qty: 1,
                unitPrice: d.price,
                discountPct: 0,
                warrantyMonths: null,
                agreedPrice: d.priceSource === 'agreed',
                serial: d.serial,
                cost: d.cost,
              })),
            ],
          })
        }
        partnerId={v.partnerId}
        models={models}
        categories={lookups.categories}
        warehouses={lookups.warehouses}
        exclude={v.lines.map((l) => l.itemId).filter((x): x is string => !!x)}
      />
      <CatalogPicker
        open={picker === 'models'}
        onClose={() => setPicker(null)}
        title="Model — stavka bez serijskih brojeva"
        entries={models.map((m) => ({ id: m.id, label: modelName(m), hint: m.salePrice ? null : 'cijena iz marže', price: m.salePrice }))}
        onPick={addModel}
      />
      <CatalogPicker
        open={picker === 'services'}
        onClose={() => setPicker(null)}
        title="Usluge iz šifrarnika"
        entries={services.map((s) => ({ id: s.id, label: s.name, hint: s.unit, price: s.price }))}
        onPick={addService}
        empty="Nema usluga — dodajte ih u Postavke → Šifrarnici."
      />
    </div>
  );
}
