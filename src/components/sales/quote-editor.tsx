'use client';

import { useMemo, useState } from 'react';
import { Boxes, Info, Layers, PenLine, Save, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, Badge, Notice } from '@/components/ui/misc';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import { PartnerCombobox } from '@/components/partners/partner-combobox';
import { useAction } from '@/components/ui/action';
import { useToast } from '@/components/ui/toast';
import { eur } from '@/lib/format';
import { documentTotals, unifyDevicePrices } from '@/domain/invoice';
import { customerVat } from '@/domain/tax';
import { addDays } from '@/domain/dates';
import { PROFORMA_TITLES } from '@/domain/documents';
import { modelQuotePrice, saveQuoteAction } from '@/app/(app)/prodaja/ponude/actions';
import { customerPrices } from '@/app/(app)/prodaja/racuni/actions';
import { DevicePicker } from './device-picker';
import { CatalogPicker } from './catalog-picker';
import { LinesTable, editorLineCount } from './lines-table';
import { TaxFields } from './invoice-tax-fields';
import { TotalsBox } from './totals-box';
import { lineKey } from './inputs';
import { ServicePicker } from './service-picker';
import { modelName, type EditorLine, type PartnerOpt, type SalesLookups, type ServiceOpt } from './types';
import { plural } from '@/domain/plural';

export interface QuoteEditorValue {
  id: string | null;
  /** Ponuda ili predračun (samo pri izradi). */
  kind?: 'QUOTE' | 'PROFORMA';
  /** Predračun: naslov na dokumentu (prazno = iz postavki firme). */
  title?: string;
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
export function QuoteEditor({
  initial,
  lookups,
  stock: initialStock,
  showCost = true,
  canCreateService = false,
}: {
  initial: QuoteEditorValue;
  lookups: SalesLookups;
  stock: Record<string, number>;
  showCost?: boolean;
  canCreateService?: boolean;
}) {
  const { models, company } = lookups;
  // poznati partneri: trenutni kupac + odabrani pretragom (cijeli popis se ne šalje u preglednik)
  const [partners, setPartners] = useState<PartnerOpt[]>(lookups.partners);
  const [services, setServices] = useState<ServiceOpt[]>(lookups.services);
  const [v, setV] = useState<QuoteEditorValue>(initial);
  const [stock, setStock] = useState(initialStock);
  const [picker, setPicker] = useState<'devices' | 'services' | 'models' | null>(null);
  const [validTouched, setValidTouched] = useState(!!initial.id);
  const { run, pending } = useAction(saveQuoteAction);
  const price = useAction(modelQuotePrice, { refresh: false });
  const prices = useAction(customerPrices, { refresh: false });
  const toast = useToast();
  const set = (patch: Partial<QuoteEditorValue>) => setV((cur) => ({ ...cur, ...patch }));

  const partner = partners.find((p) => p.id === v.partnerId) ?? null;
  const treatment = partner ? customerVat(partner, company) : null;
  const totals = useMemo(
    () => documentTotals({ lines: v.lines, vatRate: v.vatRate, discountPct: v.discountPct, discountAmount: v.discountAmount }),
    [v.lines, v.vatRate, v.discountPct, v.discountAmount],
  );

  const choosePartner = (id: string | null, picked?: PartnerOpt) => {
    if (picked && !partners.some((x) => x.id === picked.id)) setPartners((cur) => [...cur, picked]);
    const p = picked ?? partners.find((x) => x.id === id);
    if (!p) return set({ partnerId: null });
    // kao na računu: dogovorene cijene prethodnog kupca ne vrijede za novog — stavke koje nisu ručno
    // mijenjane dobivaju cijenu novog kupca ili standardnu
    if (p.id !== v.partnerId && v.lines.some((l) => (l.itemId || l.modelId) && (l.agreedPrice || !l.priceEdited))) void repriceFor(p.id);
    set({ partnerId: p.id, vatRate: customerVat(p, company).rate });
  };

  const repriceFor = async (partnerId: string) => {
    const withModel = v.lines.filter((l) => (l.itemId || l.modelId) && (l.agreedPrice || !l.priceEdited));
    if (!withModel.length) return;
    const r = await prices.run({ partnerId, lines: withModel.map((l) => ({ key: l.key, itemId: l.itemId ?? null, modelId: l.modelId ?? null, lineType: l.lineType === 'RENT' ? 'RENT' : 'SALE' })) });
    if (!r.ok || !r.data) return;
    const found = r.data as Record<string, { price: number; agreed: boolean }>;
    const next = new Map<string, EditorLine>();
    let agreed = 0;
    let reset = 0;
    for (const l of v.lines) {
      const p = found[l.key];
      // bez dogovorene cijene mijenja se samo stavka koja je nosila dogovorenu cijenu
      if (!p || (!p.agreed && !l.agreedPrice)) continue;
      if (p.agreed) agreed++;
      else reset++;
      // ponuda: najam je mjesečni (1 mjesec)
      next.set(l.key, { ...l, unitPrice: p.price, ...(l.lineType === 'RENT' ? { monthly: p.price } : {}), agreedPrice: p.agreed, priceEdited: false });
    }
    if (!next.size) return;
    setV((cur) => ({ ...cur, lines: cur.lines.map((l) => next.get(l.key) ?? l) }));
    const msg = [agreed ? `dogovorena cijena na ${agreed} ${plural(agreed, 'stavci', 'stavke', 'stavki')}` : null, reset ? `standardna cijena vraćena na ${reset} ${plural(reset, 'stavci', 'stavke', 'stavki')}` : null].filter(Boolean).join(', ');
    toast('ok', `Cjenik kupca: ${msg}.`);
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
        {
          key: lineKey(),
          kind: 'MODEL',
          modelId,
          description: modelName(m),
          unit: 'kom',
          kpd: '',
          qty: 1,
          unitPrice: d.price,
          discountPct: 0,
          warrantyMonths: null,
          agreedPrice: d.source === 'agreed',
          suggestSale: d.price,
          suggestRent: m.rentPrice ?? null,
        },
      ],
    }));
    toast('ok', `Dodano: ${modelName(m)}`);
  };
  const addService = (s: ServiceOpt) => {
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
        lineType: l.lineType === 'RENT' ? 'RENT' : null,
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
            <PartnerCombobox role="customer" initial={partners} value={v.partnerId} onChange={choosePartner} placeholder="Odaberite kupca…" />
          </Field>
          <Field label="Datum ponude" required>
            <Input
              type="date"
              value={v.date}
              onChange={(e) => set({ date: e.target.value, ...(validTouched || !e.target.value ? {} : { validUntil: addDays(e.target.value, company.quoteValidDays) }) })}
            />
          </Field>
          {v.kind === 'PROFORMA' && (
            <Field label="Naslov na dokumentu" hint="Za ovaj dokument; zadano iz Postavke → Firma">
              <Input list="proforma-naslovi" value={v.title ?? ''} placeholder={company.proformaTitle || 'Predračun'} maxLength={60} onChange={(e) => set({ title: e.target.value })} />
              <datalist id="proforma-naslovi">
                {PROFORMA_TITLES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
          )}
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
        <LinesTable
          lines={v.lines}
          onChange={(lines) => set({ lines })}
          mode="quote"
          stock={stock}
          showCost={showCost}
          rent={{ docType: 'SALE', months: 1, company, models, allowRent: true }}
        />
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

      <div className="no-print sticky bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-30 -mx-3 mt-4 border-t border-line bg-panel/95 px-3 py-2.5 backdrop-blur sm:-mx-5 sm:px-5 lg:bottom-0 lg:-mb-5">
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-sm text-fg-3">
            {editorLineCount(v.lines)} {plural(editorLineCount(v.lines), 'stavka', 'stavke', 'stavki')} · ukupno <b className="text-fg tnum">{eur(totals.total)}</b>
          </span>
          <Button variant="primary" icon={<Save className="size-4" />} loading={pending} disabled={!v.partnerId || !v.lines.length} onClick={save}>
            {v.kind === 'PROFORMA' ? `Spremi — ${(v.title?.trim() || company.proformaTitle || 'Predračun').toLowerCase()}` : 'Spremi ponudu'}
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
              ...unifyDevicePrices(v.lines, ds.map((d): EditorLine => ({
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
                suggestSale: d.price,
                suggestRent: d.rent ?? null,
              }))),
            ],
          })
        }
        partnerId={v.partnerId}
        models={models}
        categories={lookups.categories}
        warehouses={lookups.warehouses}
        exclude={v.lines.map((l) => l.itemId).filter((x): x is string => !!x)}
        supplierFilter
        statuses={lookups.statuses}
        showCost={showCost}
      />
      <CatalogPicker
        open={picker === 'models'}
        onClose={() => setPicker(null)}
        title="Model — stavka bez serijskih brojeva"
        entries={models.map((m) => ({ id: m.id, label: modelName(m), hint: m.salePrice ? null : 'cijena iz marže', price: m.salePrice }))}
        onPick={addModel}
      />
      <ServicePicker
        open={picker === 'services'}
        onClose={() => setPicker(null)}
        services={services}
        onPick={addService}
        onCreated={(x) => setServices((cur) => [...cur, x].sort((a, b) => a.name.localeCompare(b.name, 'hr')))}
        canCreate={canCreateService}
      />
    </div>
  );
}
