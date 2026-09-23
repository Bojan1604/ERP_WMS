'use client';

import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Textarea } from '@/components/ui/field';
import { ActionForm, FormError, type ServerAction } from '@/components/ui/action';

export interface ServiceFields {
  id: string;
  issue: string;
  diagnosis: string | null;
  action: string | null;
  solution: string | null;
  cost: number;
  underWarranty: boolean;
  publicNote: string | null;
  note: string | null;
  reportedAt: string;
  receivedAt: string | null;
}

/** Sva polja naloga; spremanje ne mijenja status. */
export function ServiceEditForm({ value, action, readOnly }: { value: ServiceFields; action: ServerAction<FormData>; readOnly?: boolean }) {
  return (
    <ActionForm action={action} successMessage="Nalog spremljen.">
      {({ pending, error, fields }) => (
        <fieldset disabled={readOnly} className="space-y-3">
          <input type="hidden" name="id" value={value.id} />
          <FormGrid cols={2}>
            <Field label="Opis kvara" required className="sm:col-span-2" error={fields.issue}>
              <Textarea name="issue" rows={3} defaultValue={value.issue} />
            </Field>
            <Field label="Dijagnoza">
              <Textarea name="diagnosis" rows={3} defaultValue={value.diagnosis ?? ''} />
            </Field>
            <Field label="Poduzeta akcija">
              <Textarea name="action" rows={3} defaultValue={value.action ?? ''} />
            </Field>
            <Field label="Rješenje" className="sm:col-span-2">
              <Textarea name="solution" rows={2} defaultValue={value.solution ?? ''} />
            </Field>
            <Field label="Poruka klijentu" hint="Ispisuje se na nalogu za klijenta">
              <Textarea name="publicNote" rows={3} defaultValue={value.publicNote ?? ''} />
            </Field>
            <Field label="Interna napomena" hint="Samo za nas — ne ispisuje se">
              <Textarea name="note" rows={3} defaultValue={value.note ?? ''} />
            </Field>
          </FormGrid>
          <FormGrid cols={4}>
            <Field label="Prijavljeno" required>
              <Input type="date" name="reportedAt" defaultValue={value.reportedAt} />
            </Field>
            <Field label="Zaprimljeno">
              <Input type="date" name="receivedAt" defaultValue={value.receivedAt ?? ''} />
            </Field>
            <Field label="Trošak popravka (€)" error={fields.cost}>
              <Input type="number" step="0.01" min={0} name="cost" defaultValue={value.cost} />
            </Field>
            <div className="flex items-end pb-1.5">
              <Checkbox name="underWarranty" label="U jamstvu" defaultChecked={value.underWarranty} />
            </div>
          </FormGrid>
          <FormError error={error} />
          {!readOnly && (
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={pending}>
                Spremi
              </Button>
            </div>
          )}
        </fieldset>
      )}
    </ActionForm>
  );
}
