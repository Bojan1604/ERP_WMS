'use client';

import { useState } from 'react';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { Combobox } from '@/components/ui/combobox';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Card } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { supplierVat } from '@/domain/tax';
import { r2 } from '@/domain/money';

export interface SupplierInvoiceValue {
  id: string | null;
  internalNo: string | null;
  supplierId: string | null;
  number: string;
  issueDate: string;
  dueDate: string | null;
  netAmount: number;
  vatAmount: number;
  total: number;
  category: string | null;
  note: string | null;
  paidDate: string | null;
  book: boolean;
}

type SaveInput = Omit<SupplierInvoiceValue, 'internalNo' | 'supplierId'> & { supplierId: string };

/**
 * Unos i izmjena ulaznog računa; PDV se predlaže po državi dobavljača.
 * eRačun: dobavljač, broj, datum i iznosi dolaze iz XML-a i ne mijenjaju se
 * (`lockDocument`); odbijeni račun se ne plaća ni knjiži (`rejected`).
 */
export function SupplierInvoiceForm({
  initial,
  suppliers,
  categories,
  company,
  action,
  lockDocument = false,
  rejected = false,
}: {
  initial: SupplierInvoiceValue;
  suppliers: Array<{ value: string; label: string; country: string }>;
  categories: string[];
  company: { vatRate: number; country: string };
  action: ServerAction<SaveInput, { warning?: string | null } | unknown>;
  lockDocument?: boolean;
  rejected?: boolean;
}) {
  const [v, setV] = useState(initial);
  const [vatTouched, setVatTouched] = useState(!!initial.id);
  const [totalTouched, setTotalTouched] = useState(!!initial.id && r2(initial.netAmount + initial.vatAmount) !== initial.total);
  const [localError, setLocalError] = useState<string | null>(null);
  const toast = useToast();
  const { run, pending, error } = useAction(action, {
    onSuccess: (d) => {
      const w = (d as { warning?: string | null } | undefined)?.warning;
      if (w) toast('bad', w);
    },
  });

  const supplier = suppliers.find((s) => s.value === v.supplierId);
  const vatInfo = supplierVat(supplier?.country, company);
  const recompute = (patch: Partial<SupplierInvoiceValue>, s = v, country = supplier?.country) => {
    const next = { ...s, ...patch };
    if (!vatTouched) next.vatAmount = r2((next.netAmount * supplierVat(country, company).rate) / 100);
    if (!totalTouched) next.total = r2(next.netAmount + next.vatAmount);
    setV(next);
  };

  const submit = () => {
    if (!v.supplierId) return setLocalError('Odaberite dobavljača.');
    if (!v.number.trim()) return setLocalError('Upišite broj računa dobavljača.');
    setLocalError(null);
    const { internalNo: _ignored, ...rest } = v;
    void _ignored;
    run({ ...rest, supplierId: v.supplierId });
  };

  return (
    <div className="space-y-4">
      <Card title={v.internalNo ? `Ulazni račun ${v.internalNo}` : 'Novi ulazni račun'}>
        <FormGrid cols={4}>
          <Field label="Dobavljač" required className="sm:col-span-2">
            <Combobox
              options={suppliers.map((s) => ({ value: s.value, label: s.label, hint: s.country !== company.country ? s.country : undefined }))}
              value={v.supplierId}
              onChange={(id) => {
                const c = suppliers.find((s) => s.value === id)?.country;
                recompute({ supplierId: id }, v, c);
              }}
              placeholder="Odaberite dobavljača…"
              disabled={lockDocument}
            />
          </Field>
          <Field label="Broj računa dobavljača" required>
            <Input value={v.number} disabled={lockDocument} onChange={(e) => setV({ ...v, number: e.target.value })} />
          </Field>
          <Field label="Interni broj" hint={v.internalNo ? undefined : 'Dodjeljuje se pri spremanju'}>
            <Input value={v.internalNo ?? ''} disabled placeholder="URA-…" />
          </Field>
          <Field label="Datum računa" required>
            <Input type="date" value={v.issueDate} disabled={lockDocument} onChange={(e) => setV({ ...v, issueDate: e.target.value })} />
          </Field>
          <Field label="Dospijeće">
            <Input type="date" value={v.dueDate ?? ''} onChange={(e) => setV({ ...v, dueDate: e.target.value || null })} />
          </Field>
          <Field label="Kategorija troška" className="sm:col-span-2">
            <Select placeholder="— bez kategorije —" options={categories.map((c) => ({ value: c, label: c }))} value={v.category ?? ''} onChange={(e) => setV({ ...v, category: e.target.value || null })} />
          </Field>
          <Field label="Osnovica (bez PDV-a)" required>
            <Input type="number" step="0.01" value={v.netAmount} disabled={lockDocument} onChange={(e) => recompute({ netAmount: Number(e.target.value) })} />
          </Field>
          <Field label="PDV" hint={vatTouched ? 'Upisano ručno' : vatInfo.label}>
            <Input
              type="number"
              step="0.01"
              value={v.vatAmount}
              disabled={lockDocument}
              onChange={(e) => {
                setVatTouched(true);
                const vat = Number(e.target.value);
                setV({ ...v, vatAmount: vat, total: totalTouched ? v.total : r2(v.netAmount + vat) });
              }}
            />
          </Field>
          <Field label="Ukupno">
            <Input
              type="number"
              step="0.01"
              value={v.total}
              disabled={lockDocument}
              onChange={(e) => {
                setTotalTouched(true);
                setV({ ...v, total: Number(e.target.value) });
              }}
            />
          </Field>
          <Field label="Plaćeno dana" hint="Prazno = nije plaćeno">
            <Input type="date" value={v.paidDate ?? ''} disabled={rejected} onChange={(e) => setV({ ...v, paidDate: e.target.value || null })} />
          </Field>
          <Field label="Napomena" className="sm:col-span-4">
            <Textarea rows={2} value={v.note ?? ''} onChange={(e) => setV({ ...v, note: e.target.value })} />
          </Field>
        </FormGrid>
        <div className="mt-3">
          <Checkbox label="Knjiži kao trošak" checked={v.book} disabled={rejected} onChange={(e) => setV({ ...v, book: e.target.checked })} />
          <p className="mt-1 text-xs text-fg-3">
            Za račun robe koja je zaprimljena primkom trošak je već knjižen primkom — isključite knjiženje da se trošak ne zbroji dvaput.
          </p>
          {lockDocument && <p className="mt-1 text-xs text-fg-3">Dobavljač, broj, datum i iznosi eRačuna preuzeti su iz XML-a i ne mijenjaju se.</p>}
        </div>
      </Card>
      <FormError error={localError ?? error} />
      <div className="flex justify-end gap-2">
        <LinkButton href="/nabava/ulazni">Odustani</LinkButton>
        <Button variant="primary" loading={pending} onClick={submit}>
          Spremi
        </Button>
      </div>
    </div>
  );
}
