'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BadgeEuro, Boxes, Info, PenLine, Save, Send, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, Badge, Notice } from '@/components/ui/misc';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Combobox } from '@/components/ui/combobox';
import { useAction } from '@/components/ui/action';
import { useToast } from '@/components/ui/toast';
import { eur } from '@/lib/format';
import { documentTotals, unifyDevicePrices } from '@/domain/invoice';
import { customerVat, mixedSupplyError, supplyKindOf } from '@/domain/tax';
import { addDays, today } from '@/domain/dates';
import { r2 } from '@/domain/money';
import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type PaymentMethodCode } from '@/domain/fiscal';
import { customerPrices, saveInvoice } from '@/app/(app)/prodaja/racuni/actions';
import { DevicePicker, type PickMode } from './device-picker';
import { ServicePicker } from './service-picker';
import { LinesTable, editorLineCount } from './lines-table';
import { TaxFields } from './invoice-tax-fields';
import { TotalsBox } from './totals-box';
import { lineKey } from './inputs';
import { autoKpd, deviceToLine as toLine, isRentLine, withRentMonths } from './line-tools';
import { IssueDialog } from './invoice-issue-dialog';
import { AdvancePicker, type AdvanceChoice } from './invoice-advances';
import { RentCard, rentMonthsFor, type ContractOpt, type RentNextValue, type RentTermsValue } from './invoice-rent-card';
import type { DeviceOpt, EditorCharge, EditorLine, SalesLookups, ServiceOpt } from './types';

export interface InvoiceEditorValue {
  id: string | null;
  type: 'SALE' | 'SERVICE' | 'RENT';
  kind: 'INVOICE' | 'ADVANCE';
  partnerId: string | null;
  date: string;
  dueDate: string;
  deliveryDate: string;
  vatRate: number;
  taxCategory: string;
  taxExemptReason: string;
  discountPct: number;
  discountAmount: number;
  /** Uračunati predujmovi (samo konačni račun). */
  advances: AdvanceChoice[];
  charges: EditorCharge[];
  paymentMethod: PaymentMethodCode;
  description: string;
  note: string;
  lines: EditorLine[];
  /** Najam: id ugovora, 'new' = novi ugovor s uvjetima `rent`, null = još nije odabran. */
  contractId?: string | null;
  /** Razdoblje najma (YYYY-MM); prazno = prva nefakturirana rata. */
  period?: string;
  rent?: RentTermsValue;
  /** „Zatim naplata prelazi u" (druga naplata od datuma) — za uređaje koji se dodaju na ugovor. */
  rentNext?: RentNextValue | null;
  /** Rata iz modula Najam (ugovor i razdoblje zadani). */
  rentLocked?: boolean;
  contract?: { id: string; number: string } | null;
}

/** Editor nacrta računa: kupac, datumi, stavke (prodaja i najam), popusti, naknade i živi zbrojevi. */
export function InvoiceEditor({
  initial,
  lookups,
  showCost = true,
  canCreateService = false,
}: {
  initial: InvoiceEditorValue;
  lookups: SalesLookups;
  showCost?: boolean;
  canCreateService?: boolean;
}) {
  const { partners, company, models } = lookups;
  const [services, setServices] = useState<ServiceOpt[]>(lookups.services);
  const [v, setV] = useState<InvoiceEditorValue>({
    contractId: null,
    period: '',
    rent: { startDate: initial.date, billing: 'MONTHLY', months: 24, seasonFrom: null, seasonTo: null },
    ...initial,
  });
  const [contracts, setContracts] = useState<ContractOpt[]>([]);
  const [dueTouched, setDueTouched] = useState(!!initial.id);
  const [picker, setPicker] = useState<'devices' | 'services' | null>(null);
  const [confirmIssue, setConfirmIssue] = useState(false);
  const { run, pending } = useAction(saveInvoice);
  const prices = useAction(customerPrices, { refresh: false });
  const toast = useToast();
  const set = (patch: Partial<InvoiceEditorValue>) => setV((cur) => ({ ...cur, ...patch }));

  const partner = partners.find((p) => p.id === v.partnerId) ?? null;
  const term = partner?.paymentTermDays ?? company.paymentTermDays;
  // porezni tretman prema vrsti isporuke: prodaja = roba, najam i servis = usluga (strani kupac)
  const supply = supplyKindOf(v.type, v.lines);
  const vatKind = supply === 'MIXED' ? 'SALE' : supply;
  const treatment = partner ? customerVat(partner, company, vatKind) : null;
  const mixedError = partner ? mixedSupplyError(partner, company, v.taxCategory, supply) : null;
  // promjena vrste isporuke: automatski tretman se preračunava, ručno promijenjen ostaje
  const autoVat = useRef(treatment);
  useEffect(() => {
    const prev = autoVat.current;
    autoVat.current = treatment;
    if (!prev || !treatment || (prev.category === treatment.category && prev.exemptReason === treatment.exemptReason && prev.rate === treatment.rate)) return;
    setV((cur) =>
      cur.taxCategory === prev.category && (cur.taxExemptReason ?? '') === (prev.exemptReason ?? '') && cur.vatRate === prev.rate
        ? { ...cur, taxCategory: treatment.category, taxExemptReason: treatment.exemptReason ?? '', vatRate: treatment.rate }
        : cur,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treatment?.category, treatment?.exemptReason, treatment?.rate]);
  const rentUsed = v.type === 'RENT' || v.lines.some((l) => l.lineType === 'RENT');
  const rentMonths = rentMonthsFor(v.contractId ?? null, contracts, v.rent!);
  const totals = useMemo(
    () =>
      documentTotals({
        lines: v.lines,
        vatRate: v.vatRate,
        discountPct: v.discountPct,
        discountAmount: v.discountAmount,
        charges: v.charges.map((c) => ({ kind: c.kind, label: c.label, amount: c.amount ?? 0, pct: c.pct ?? 0 })),
      }),
    [v.lines, v.vatRate, v.discountPct, v.discountAmount, v.charges],
  );
  const rentCtx = { docType: v.type, months: rentMonths, company, models, allowRent: v.type !== 'SERVICE', locked: v.rentLocked };

  const choosePartner = (id: string | null) => {
    const p = partners.find((x) => x.id === id);
    if (!p) return set({ partnerId: null });
    // dogovorene cijene prethodnog kupca ne vrijede za novog — stavke dobivaju cijenu novog kupca ili standardnu
    if (p.id !== v.partnerId && v.lines.some((l) => l.agreedPrice)) void repriceFor(p.id, false);
    const t = customerVat(p, company, vatKind);
    set({
      partnerId: p.id,
      vatRate: t.rate,
      taxCategory: t.category,
      taxExemptReason: t.exemptReason ?? '',
      // ugovor i predujmovi pripadaju kupcu — promjenom kupca odabir se briše
      ...(v.rentLocked ? {} : { contractId: null }),
      advances: [],
      ...(dueTouched ? {} : { dueDate: addDays(v.date, p.paymentTermDays ?? company.paymentTermDays) }),
    });
  };

  const addLines = (lines: EditorLine[]) => setV((cur) => ({ ...cur, lines: [...cur.lines, ...lines] }));
  const addService = (s: ServiceOpt) =>
    addLines([
      {
        key: lineKey(),
        kind: 'SERVICE',
        serviceId: s.id,
        description: s.name,
        unit: s.unit,
        kpd: s.kpd ?? autoKpd({ kind: 'SERVICE' }, 'SERVICE', company, models, null),
        qty: 1,
        unitPrice: s.price,
        discountPct: 0,
        warrantyMonths: null,
        agreedPrice: false,
      },
    ]);
  const addManual = () =>
    addLines([
      {
        key: lineKey(),
        kind: 'MANUAL',
        description: '',
        unit: 'kom',
        kpd: autoKpd({ kind: 'MANUAL' }, v.type, company, models),
        qty: 1,
        unitPrice: 0,
        discountPct: 0,
        warrantyMonths: null,
        agreedPrice: false,
      },
    ]);
  const addDevices = (ds: DeviceOpt[], mode: PickMode) => {
    // postojeći najmovi i račun za najam → stavke najma; inače prodaja (vrsta se mijenja na stavci)
    const lineType = mode === 'rented' || v.type === 'RENT' ? 'RENT' : 'SALE';
    const lines = ds.map((d) => toLine(d, { lineType, months: rentMonths, company, models, docType: v.type }));
    addLines(lineType === 'SALE' ? unifyDevicePrices(v.lines, lines) : lines);
    // postojeći najam: svi uređaji s istog ugovora → taj ugovor
    const cs = [...new Set(ds.map((d) => d.contractId).filter(Boolean))];
    if (mode === 'rented' && cs.length === 1 && !v.contractId && !v.rentLocked) set({ contractId: cs[0] });
  };

  /**
   * Cijene stavki za kupca: `all` — „Primijeni cjenik kupca" (dogovorene cijene na sve stavke,
   * a stavke s dogovorenom cijenom drugog kupca vraćaju se na standardnu); inače samo stavke
   * s dogovorenom cijenom (promjena kupca — cijena prethodnog kupca ne ostaje na računu).
   */
  const repriceFor = async (partnerId: string, all: boolean) => {
    const withModel = v.lines.filter((l) => (l.itemId || l.modelId) && (all || l.agreedPrice));
    if (!withModel.length) return;
    const r = await prices.run({ partnerId, lines: withModel.map((l) => ({ key: l.key, itemId: l.itemId ?? null, modelId: l.modelId ?? null, lineType: isRentLine(l, v.type) ? 'RENT' : 'SALE' })) });
    if (!r.ok || !r.data) return;
    const found = r.data as Record<string, { price: number; agreed: boolean }>;
    const next = new Map<string, EditorLine>();
    let agreed = 0;
    let reset = 0;
    for (const l of v.lines) {
      const p = found[l.key];
      // bez dogovorene cijene: mijenja se samo stavka koja je nosila dogovorenu cijenu (ručne cijene ostaju)
      if (!p || (!p.agreed && !l.agreedPrice)) continue;
      if (p.agreed) agreed++;
      else reset++;
      // kod najma je cijena mjesečna — iznos se izvodi iz nje
      next.set(
        l.key,
        isRentLine(l, v.type) ? { ...l, monthly: p.price, unitPrice: r2(p.price * (l.months ?? rentMonths)), agreedPrice: p.agreed } : { ...l, unitPrice: p.price, agreedPrice: p.agreed },
      );
    }
    setV((cur) => ({ ...cur, lines: cur.lines.map((l) => next.get(l.key) ?? l) }));
    const msg = [agreed ? `dogovorena cijena na ${agreed} stavki` : null, reset ? `standardna cijena vraćena na ${reset} stavki` : null].filter(Boolean).join(', ');
    if (all || msg) toast(agreed || reset ? 'ok' : 'bad', msg ? `Cjenik kupca: ${msg}.` : 'Kupac nema dogovorenih cijena za ove modele.');
  };
  const applyPriceList = () => (v.partnerId ? repriceFor(v.partnerId, true) : undefined);

  const save = (issue: boolean) =>
    run({
      ...v,
      issue,
      charges: v.charges.filter((c) => c.amount || c.pct),
      advances: v.kind === 'INVOICE' ? v.advances.filter((a) => a.amount > 0) : [],
      contractId: rentUsed ? (v.contractId ?? null) : null,
      period: rentUsed ? v.period || null : null,
      rent: rentUsed && v.contractId === 'new' ? v.rent : null,
      rentNext: rentUsed && v.contractId && !v.rentLocked ? (v.rentNext ?? null) : null,
      lines: v.lines.map((l) => ({
        kind: l.kind,
        itemId: l.itemId ?? null,
        modelId: l.modelId ?? null,
        serviceId: l.serviceId ?? null,
        description: l.description,
        unit: l.unit,
        kpd: l.kpd,
        qty: l.qty,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
        monthly: l.monthly ?? null,
        months: l.months ?? null,
        warrantyMonths: l.warrantyMonths,
        agreedPrice: l.agreedPrice,
        lineType: l.lineType ?? null,
      })),
    });

  const usedItems = v.lines.map((l) => l.itemId).filter((x): x is string => !!x);

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
      {partner?.excluded && <Notice tone="info">Partner je isključen iz obračuna — račun neće ulaziti u izvještaje.</Notice>}

      <Card title="Kupac i datumi" className="mb-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
          <Field label="Kupac" required className="md:col-span-3">
            <Combobox
              options={partners.map((p) => ({ value: p.id, label: p.name, hint: [p.city, p.country !== 'HR' ? p.country : null].filter(Boolean).join(', ') }))}
              value={v.partnerId}
              onChange={(id) => choosePartner(id)}
              placeholder="Odaberite kupca…"
            />
          </Field>
          <Field label="Vrsta" className="md:col-span-1">
            {v.rentLocked ? (
              <Input value="Najam" disabled />
            ) : (
              <Select
                value={v.type}
                onChange={(e) => {
                  const type = e.target.value as InvoiceEditorValue['type'];
                  // stavke bez vlastite vrste prate vrstu računa — preračun cijena najma
                  set({ type, lines: type === 'RENT' ? withRentMonths(v.lines.map((l) => (l.lineType === 'RENT' ? { ...l, lineType: null } : l)), 'RENT', rentMonths) : v.lines });
                }}
                options={[
                  { value: 'SALE', label: 'Prodaja' },
                  { value: 'RENT', label: 'Najam' },
                  { value: 'SERVICE', label: 'Usluga' },
                ]}
              />
            )}
          </Field>
          <Field label="Dokument" className="md:col-span-2">
            <Select
              value={v.kind}
              onChange={(e) => set({ kind: e.target.value as 'INVOICE' | 'ADVANCE', advances: [] })}
              options={[
                { value: 'INVOICE', label: 'Račun' },
                { value: 'ADVANCE', label: 'Račun za predujam' },
              ]}
            />
          </Field>
          <Field label="Datum računa" required className="md:col-span-2">
            <Input
              type="date"
              value={v.date}
              onChange={(e) => set({ date: e.target.value, ...(dueTouched || !e.target.value ? {} : { dueDate: addDays(e.target.value, term) }) })}
            />
          </Field>
          <Field label="Dospijeće" hint={`Rok plaćanja: ${term} dana`} className="md:col-span-2">
            <Input
              type="date"
              value={v.dueDate}
              onChange={(e) => {
                setDueTouched(true);
                set({ dueDate: e.target.value });
              }}
            />
          </Field>
          <Field label="Datum isporuke" className="md:col-span-2">
            <Input type="date" value={v.deliveryDate} onChange={(e) => set({ deliveryDate: e.target.value })} />
          </Field>
          <Field label="Način plaćanja" hint={v.paymentMethod === 'TRANSFER' ? undefined : 'Fiskalizira se: ZKI i JIR na računu'} className="md:col-span-2">
            <Select
              value={v.paymentMethod}
              onChange={(e) => set({ paymentMethod: e.target.value as PaymentMethodCode })}
              options={PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))}
            />
          </Field>
          <Field label="Opis računa" className="md:col-span-4">
            <Input value={v.description} onChange={(e) => set({ description: e.target.value })} placeholder="npr. Oprema za blagajnu — lokacija Split" />
          </Field>
        </div>
        {treatment && (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-fg-3">
            Porezni tretman: <Badge tone={treatment.category === 'S' ? 'brand' : 'info'}>{treatment.label}</Badge>
            {(treatment.rate !== v.vatRate || treatment.category !== v.taxCategory) && <Badge tone="warn">ručno promijenjeno</Badge>}
          </p>
        )}
        {v.date > today() && (
          <div className="mt-3">
            <Notice tone="warn">Datum računa je u budućnosti — nacrt se može spremiti, a račun se izdaje najkasnije s današnjim datumom (na dan isporuke).</Notice>
          </div>
        )}
        {mixedError && (
          <div className="mt-3">
            <Notice tone="warn">{mixedError}</Notice>
          </div>
        )}
      </Card>

      {rentUsed && (
        <RentCard
          partnerId={v.partnerId}
          contractId={v.contractId ?? null}
          period={v.period ?? ''}
          terms={v.rent!}
          next={v.rentNext ?? null}
          onNext={(rentNext) => set({ rentNext })}
          locked={!!v.rentLocked}
          lockedLabel={v.contract}
          onContracts={setContracts}
          onPeriod={(period) => set({ period })}
          onContract={(id, c) =>
            setV((cur) => {
              const months = rentMonthsFor(id, c ? [c] : contracts, cur.rent!);
              return { ...cur, contractId: id, lines: withRentMonths(cur.lines, cur.type, months) };
            })
          }
          onTerms={(rent) => setV((cur) => ({ ...cur, rent, lines: cur.contractId === 'new' ? withRentMonths(cur.lines, cur.type, rentMonthsFor('new', contracts, rent)) : cur.lines }))}
        />
      )}

      <Card
        title="Stavke"
        padded={false}
        className="mb-4"
        actions={
          <>
            {v.partnerId && v.lines.some((l) => l.itemId || l.modelId) && (
              <Button size="sm" icon={<BadgeEuro className="size-3.5" />} loading={prices.pending} onClick={applyPriceList} title="Primijeni dogovorene cijene ovog kupca na sve stavke">
                Primijeni cjenik kupca
              </Button>
            )}
            {!v.rentLocked && (
              <Button size="sm" variant="subtle" icon={<Boxes className="size-3.5" />} onClick={() => setPicker('devices')}>
                Uređaji sa skladišta
              </Button>
            )}
            <Button size="sm" icon={<Wrench className="size-3.5" />} onClick={() => setPicker('services')}>
              Usluga
            </Button>
            <Button size="sm" icon={<PenLine className="size-3.5" />} onClick={addManual}>
              Ručna stavka
            </Button>
          </>
        }
      >
        <LinesTable lines={v.lines} onChange={(lines) => set({ lines })} mode="invoice" rent={rentCtx} showCost={showCost} />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_22rem]">
        <Card title="Popust, porez i naknade">
          <TaxFields v={v} set={(p) => set(p as Partial<InvoiceEditorValue>)} />
          {v.kind === 'INVOICE' && (
            <div className="mt-3">
              <AdvancePicker partnerId={v.partnerId} invoiceId={v.id} value={v.advances} onChange={(advances) => set({ advances })} maxTotal={totals.total} />
            </div>
          )}
          <Field label="Napomena (ispisuje se ispod stavki)" className="mt-3">
            <Textarea value={v.note} onChange={(e) => set({ note: e.target.value })} rows={2} />
          </Field>
        </Card>
        <Card title="Zbroj">
          <TotalsBox t={totals} vatRate={v.vatRate} advance={v.kind === 'INVOICE' ? r2(v.advances.reduce((a, x) => a + x.amount, 0)) : 0} />
        </Card>
      </div>

      <div className="no-print sticky bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-30 -mx-3 mt-4 border-t border-line bg-panel/95 px-3 py-2.5 backdrop-blur sm:-mx-5 sm:px-5 lg:bottom-0 lg:-mb-5">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-sm text-fg-3 max-sm:w-full">
            {editorLineCount(v.lines)} stavki · ukupno <b className="text-fg tnum">{eur(totals.total)}</b>
          </span>
          <Button icon={<Save className="size-4" />} loading={pending} disabled={!v.partnerId} onClick={() => save(false)} className="max-sm:flex-1">
            Spremi nacrt
          </Button>
          <Button variant="primary" icon={<Send className="size-4" />} disabled={!v.partnerId || !v.lines.length || pending} onClick={() => setConfirmIssue(true)} className="max-sm:flex-1">
            Izdaj račun
          </Button>
        </div>
      </div>

      <IssueDialog
        open={confirmIssue}
        onClose={() => setConfirmIssue(false)}
        pending={pending}
        onIssue={async () => {
          const r = await save(true);
          if (r.ok) setConfirmIssue(false);
        }}
        partnerName={partner?.name ?? ''}
        total={totals.total}
        paymentMethod={v.paymentMethod}
        sellsDevices={v.type !== 'SERVICE' && v.lines.some((l) => l.kind === 'DEVICE' && !isRentLine(l, v.type))}
        rentsDevices={rentUsed && v.lines.some((l) => l.kind === 'DEVICE' && isRentLine(l, v.type))}
        contractId={v.contractId ?? null}
      />

      <DevicePicker
        open={picker === 'devices'}
        onClose={() => setPicker(null)}
        onPick={addDevices}
        partnerId={v.partnerId}
        models={models}
        categories={lookups.categories}
        warehouses={lookups.warehouses}
        suppliers={lookups.suppliers}
        statuses={lookups.statuses}
        exclude={usedItems}
        rent={v.type === 'RENT'}
        allowRented={rentUsed}
        showCost={showCost}
      />
      <ServicePicker
        open={picker === 'services'}
        onClose={() => setPicker(null)}
        services={services}
        onPick={addService}
        onCreated={(s) => setServices((cur) => [...cur, s].sort((a, b) => a.name.localeCompare(b.name, 'hr')))}
        canCreate={canCreateService}
      />
    </div>
  );
}
