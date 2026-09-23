'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { useAction, FormError } from '@/components/ui/action';
import { BILLING_MODE_LABEL, type BillingCode, type BillingModeCode } from '@/domain/billing';
import { BILLING_OPTIONS, MONTH_OPTIONS } from '@/domain/plan';
import { createContractAction, updateTermsAction } from '@/app/(app)/najam/ugovori/actions';

export interface TermsValue {
  startDate: string;
  endDate: string | null;
  firstBillingDate: string | null;
  billingDay: number | null;
  billing: BillingCode;
  billingMode: BillingModeCode;
  seasonFrom: number | null;
  seasonTo: number | null;
  note: string | null;
}

const MODE_OPTIONS: { value: BillingModeCode; label: string }[] = [
  { value: 'IN_ADVANCE', label: 'Unaprijed' },
  { value: 'IN_ARREARS', label: 'Unatrag' },
];

/**
 * Uvjeti ugovora — isti obrazac za novi ugovor (s odabirom klijenta) i za
 * izmjenu postojećeg. Kraj i sezona uključuju se prekidačem.
 */
export function ContractForm({
  mode,
  initial,
  contractId,
  partners,
  partnerId: initialPartner,
  items = [],
  readOnly,
}: {
  mode: 'create' | 'edit';
  initial: TermsValue;
  contractId?: string;
  partners?: ComboOption[];
  partnerId?: string | null;
  items?: string[];
  readOnly?: boolean;
}) {
  const [v, setV] = useState(initial);
  const [partnerId, setPartnerId] = useState<string | null>(initialPartner ?? null);
  const [fixedTerm, setFixedTerm] = useState(Boolean(initial.endDate));
  const [seasonal, setSeasonal] = useState(Boolean(initial.seasonFrom));
  const [deferred, setDeferred] = useState(Boolean(initial.firstBillingDate && initial.firstBillingDate !== initial.startDate));
  const set = <K extends keyof TermsValue>(k: K, val: TermsValue[K]) => setV((p) => ({ ...p, [k]: val }));

  const create = useAction(createContractAction);
  const update = useAction(updateTermsAction);
  const { pending, error, fields } = mode === 'create' ? create : update;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const terms = {
      ...v,
      endDate: fixedTerm ? v.endDate : null,
      firstBillingDate: deferred ? v.firstBillingDate : null,
      seasonFrom: seasonal ? (v.seasonFrom ?? 4) : null,
      seasonTo: seasonal ? (v.seasonTo ?? 10) : null,
    };
    if (mode === 'create') create.run({ ...terms, partnerId: partnerId ?? '', items });
    else update.run({ ...terms, id: contractId! });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <FormGrid cols={mode === 'create' ? 2 : 3}>
        {mode === 'create' && (
          <Field label="Klijent" required error={fields.partnerId} className="sm:col-span-2">
            <Combobox options={partners ?? []} value={partnerId} onChange={(id) => setPartnerId(id)} placeholder="Odaberite klijenta…" />
          </Field>
        )}
        <Field label="Početak ugovora" required error={fields.startDate}>
          <Input type="date" value={v.startDate} disabled={readOnly} onChange={(e) => set('startDate', e.target.value)} required />
        </Field>
        <Field label="Kraj ugovora" hint={fixedTerm ? undefined : 'Ugovor je bez roka.'} error={fields.endDate}>
          <div className="flex items-center gap-2">
            <Checkbox label="Ugovor na određeno" checked={fixedTerm} disabled={readOnly} onChange={(e) => setFixedTerm(e.target.checked)} className="shrink-0" />
            {fixedTerm && <Input type="date" value={v.endDate ?? ''} disabled={readOnly} onChange={(e) => set('endDate', e.target.value || null)} required />}
          </div>
        </Field>
        <Field label="Prva naplata" hint={deferred ? 'Odgoda: rate kreću od ovog datuma.' : 'Naplata kreće od početka ugovora.'} error={fields.firstBillingDate}>
          <div className="flex items-center gap-2">
            <Checkbox label="Odgoda" checked={deferred} disabled={readOnly} onChange={(e) => setDeferred(e.target.checked)} className="shrink-0" />
            {deferred && <Input type="date" value={v.firstBillingDate ?? ''} disabled={readOnly} onChange={(e) => set('firstBillingDate', e.target.value || null)} required />}
          </div>
        </Field>
        <Field label="Naplata" required>
          <Select options={BILLING_OPTIONS} value={v.billing} disabled={readOnly} onChange={(e) => set('billing', e.target.value as BillingCode)} />
        </Field>
        <Field label="Kada se fakturira" hint={BILLING_MODE_LABEL[v.billingMode]}>
          <Select options={MODE_OPTIONS} value={v.billingMode} disabled={readOnly} onChange={(e) => set('billingMode', e.target.value as BillingModeCode)} />
        </Field>
        <Field label="Dan naplate" hint="Prazno = dan prve naplate." error={fields.billingDay}>
          <Input
            type="number"
            min={1}
            max={31}
            value={v.billingDay ?? ''}
            disabled={readOnly}
            onChange={(e) => set('billingDay', e.target.value ? Number(e.target.value) : null)}
          />
        </Field>
        <Field label="Sezonski najam" className={mode === 'edit' ? 'sm:col-span-2' : undefined} hint={seasonal ? 'Naplata teče samo u sezoni, svake godine.' : 'Naplata cijele godine.'}>
          <div className="flex items-center gap-2">
            <Checkbox label="Sezona" checked={seasonal} disabled={readOnly} onChange={(e) => setSeasonal(e.target.checked)} className="shrink-0" />
            {seasonal && (
              <>
                <Select aria-label="Sezona od" className="w-32" options={MONTH_OPTIONS} value={String(v.seasonFrom ?? 4)} disabled={readOnly} onChange={(e) => set('seasonFrom', Number(e.target.value))} />
                <span className="text-fg-3">–</span>
                <Select aria-label="Sezona do" className="w-32" options={MONTH_OPTIONS} value={String(v.seasonTo ?? 10)} disabled={readOnly} onChange={(e) => set('seasonTo', Number(e.target.value))} />
              </>
            )}
          </div>
        </Field>
        <Field label="Napomena" className={mode === 'create' ? 'sm:col-span-2' : 'sm:col-span-3'}>
          <Textarea rows={2} value={v.note ?? ''} disabled={readOnly} onChange={(e) => set('note', e.target.value || null)} />
        </Field>
      </FormGrid>
      <FormError error={error} />
      {!readOnly && (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={pending} icon={<Save className="size-4" />}>
            {mode === 'create' ? (items.length ? `Otvori ugovor i dodaj uređaje (${items.length})` : 'Otvori ugovor') : 'Spremi uvjete'}
          </Button>
        </div>
      )}
    </form>
  );
}
