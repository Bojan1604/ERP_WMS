'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ActionForm, FormError } from '@/components/ui/action';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Field, FormGrid, Input, Select, Textarea, type Option } from '@/components/ui/field';
import { PartnerField } from './pickers';
import { searchInvoicesForItem, updateItemAction } from '@/app/(app)/skladiste/actions';

export interface ItemFormValues {
  id: string;
  serial: string;
  dupNote: string | null;
  modelId: string;
  warehouseId: string | null;
  supplier: { value: string; label: string } | null;
  cost: number;
  rentPrice: number | null;
  marginPct: number | null;
  warrantyMonths: number | null;
  importDate: string | null;
  note: string | null;
  cpu: string | null;
  screen: string | null;
  os: string | null;
  categoryId: string | null;
  salePrice: number | null;
  issueDate: string | null;
  invoice: { value: string; label: string } | null;
  partner: { value: string; label: string } | null;
}

const dec = (v: number | null) => (v === null || v === undefined ? '' : v.toFixed(2).replace('.', ','));

/** Odabir računa s pretragom na poslužitelju (ručna veza uređaja s računom). */
function InvoiceField({ initial }: { initial: ComboOption | null }) {
  const [v, setV] = useState<string | null>(initial?.value ?? null);
  const onSearch = useCallback(async (q: string): Promise<ComboOption[]> => {
    const r = await searchInvoicesForItem({ q });
    return r.ok ? (r.data ?? []) : [];
  }, []);
  return <Combobox name="invoiceId" options={initial ? [initial] : []} value={v} onChange={setV} onSearch={onSearch} placeholder="— bez računa —" allowEmpty />;
}

/**
 * Obrazac kartice uređaja (razina „uređivanje"): osnovni podaci, specifikacije
 * (procesor, ekran, OS — zadano s modela) i ručni ispravci (kategorija po komadu,
 * prodajna cijena, datum izlaza, povezani račun, klijent). Bez prava na nabavne
 * cijene nabavna i marža se ne prikazuju ni ne šalju.
 */
export function ItemForm({
  item,
  models,
  warehouses,
  categories,
  hasDuplicates,
  canSeeCost,
  modelSpecs,
  partnerLocked,
}: {
  item: ItemFormValues;
  models: Option[];
  warehouses: Option[];
  categories: Option[];
  hasDuplicates: boolean;
  canSeeCost: boolean;
  /** Specifikacije modela — prijedlog u praznim poljima. */
  modelSpecs: { cpu: string | null; screen: string | null; os: string | null };
  /** Razlog zašto se klijent ne mijenja ovdje (uređaj na ugovoru ili na skladištu); null = mijenja se. */
  partnerLocked: string | null;
}) {
  return (
    <ActionForm action={updateItemAction} className="space-y-3">
      {({ pending, error, fields }) => (
        <>
          <input type="hidden" name="id" value={item.id} />
          <FormGrid>
            <Field label="Serijski broj" required error={fields.serial}>
              <Input name="serial" defaultValue={item.serial} required className="font-mono" />
            </Field>
            <Field
              label="Razlikovna napomena"
              hint={hasDuplicates ? 'Obavezna — isti serijski broj ima i drugi uređaj.' : 'Samo kad isti serijski broj ima više uređaja.'}
              error={fields.dupNote}
            >
              <Input name="dupNote" defaultValue={item.dupNote ?? ''} />
            </Field>
            <Field label="Model" required error={fields.modelId}>
              <Select name="modelId" defaultValue={item.modelId} options={models} />
            </Field>
            <Field label="Kategorija (ovaj komad)" hint="Prazno = kategorija modela">
              <Select name="categoryId" defaultValue={item.categoryId ?? ''} placeholder="— kao model —" options={categories} />
            </Field>
            <Field label="Skladište" hint="Promjena skladišta stvara međuskladišnicu.">
              <Select name="warehouseId" defaultValue={item.warehouseId ?? ''} placeholder="— bez skladišta —" options={warehouses} />
            </Field>
            <Field label="Dobavljač">
              <PartnerField name="supplierId" role="supplier" initial={item.supplier} placeholder="— bez dobavljača —" />
            </Field>
          </FormGrid>
          <FormGrid cols={3}>
            <Field label="Procesor" error={fields.cpu}>
              <Input name="cpu" defaultValue={item.cpu ?? ''} placeholder={modelSpecs.cpu ?? ''} />
            </Field>
            <Field label="Ekran" error={fields.screen}>
              <Input name="screen" defaultValue={item.screen ?? ''} placeholder={modelSpecs.screen ?? ''} />
            </Field>
            <Field label="Operativni sustav" error={fields.os}>
              <Input name="os" defaultValue={item.os ?? ''} placeholder={modelSpecs.os ?? ''} />
            </Field>
          </FormGrid>
          <FormGrid cols={4}>
            {canSeeCost && (
              <Field label="Nabavna cijena (€)" error={fields.cost}>
                <Input name="cost" inputMode="decimal" defaultValue={dec(item.cost)} className="text-right" />
              </Field>
            )}
            <Field label="Prodajna cijena (€)" hint="Prazno = iz računa" error={fields.salePrice}>
              <Input name="salePrice" inputMode="decimal" defaultValue={dec(item.salePrice)} className="text-right" />
            </Field>
            <Field label="Najam mj. (€)" hint="Prazno = cijena modela">
              <Input name="rentPrice" inputMode="decimal" defaultValue={dec(item.rentPrice)} className="text-right" />
            </Field>
            {canSeeCost && (
              <Field label="Marža (%)" hint="Prazno = model / firma">
                <Input name="marginPct" inputMode="decimal" defaultValue={dec(item.marginPct)} className="text-right" />
              </Field>
            )}
            <Field label="Jamstvo (mj.)" hint="Prazno = model / firma">
              <Input name="warrantyMonths" type="number" min={0} max={240} defaultValue={item.warrantyMonths ?? ''} />
            </Field>
          </FormGrid>
          <FormGrid cols={4}>
            <Field label="Datum uvoza">
              <Input name="importDate" type="date" defaultValue={item.importDate ?? ''} />
            </Field>
            <Field label="Datum izlaza" hint="Datum izdavanja kupcu">
              <Input name="issueDate" type="date" defaultValue={item.issueDate ?? ''} />
            </Field>
            <Field label="Račun" hint="Ručna veza s računom">
              <InvoiceField initial={item.invoice} />
            </Field>
            <Field label="Klijent" hint={partnerLocked ?? undefined} error={fields.partnerId}>
              {partnerLocked ? (
                <Input value={item.partner?.label ?? '—'} disabled />
              ) : (
                <PartnerField name="partnerId" role="customer" initial={item.partner} placeholder="— bez klijenta —" />
              )}
            </Field>
          </FormGrid>
          <Field label="Napomena">
            <Textarea name="note" defaultValue={item.note ?? ''} rows={2} />
          </Field>
          <FormError error={error} />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={pending}>
              Spremi
            </Button>
          </div>
        </>
      )}
    </ActionForm>
  );
}
