'use client';

import { Button } from '@/components/ui/button';
import { ActionForm, FormError } from '@/components/ui/action';
import { Field, FormGrid, Input, Select, Textarea, type Option } from '@/components/ui/field';
import { PartnerField } from './pickers';
import { updateItemAction } from '@/app/(app)/skladiste/actions';

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
}

const dec = (v: number | null) => (v === null || v === undefined ? '' : v.toFixed(2).replace('.', ','));

/** Obrazac kartice uređaja (razina „uređivanje"). */
export function ItemForm({ item, models, warehouses, hasDuplicates }: { item: ItemFormValues; models: Option[]; warehouses: Option[]; hasDuplicates: boolean }) {
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
            <Field label="Skladište" hint="Promjena skladišta stvara međuskladišnicu.">
              <Select name="warehouseId" defaultValue={item.warehouseId ?? ''} placeholder="— bez skladišta —" options={warehouses} />
            </Field>
            <Field label="Dobavljač">
              <PartnerField name="supplierId" role="supplier" initial={item.supplier} placeholder="— bez dobavljača —" />
            </Field>
            <Field label="Datum uvoza">
              <Input name="importDate" type="date" defaultValue={item.importDate ?? ''} />
            </Field>
          </FormGrid>
          <FormGrid cols={4}>
            <Field label="Nabavna cijena (€)" error={fields.cost}>
              <Input name="cost" inputMode="decimal" defaultValue={dec(item.cost)} className="text-right" />
            </Field>
            <Field label="Najam mj. (€)" hint="Prazno = cijena modela">
              <Input name="rentPrice" inputMode="decimal" defaultValue={dec(item.rentPrice)} className="text-right" />
            </Field>
            <Field label="Marža (%)" hint="Prazno = model / firma">
              <Input name="marginPct" inputMode="decimal" defaultValue={dec(item.marginPct)} className="text-right" />
            </Field>
            <Field label="Jamstvo (mj.)" hint="Prazno = model / firma">
              <Input name="warrantyMonths" type="number" min={0} max={240} defaultValue={item.warrantyMonths ?? ''} />
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
