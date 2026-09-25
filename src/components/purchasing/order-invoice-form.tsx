'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormGrid, Input } from '@/components/ui/field';
import { FormError, useAction } from '@/components/ui/action';
import { parseNumber, r2 } from '@/domain/money';
import { saveOrderInvoiceAction } from '@/app/(app)/nabava/narudzbenice/actions';

export interface OrderInvoiceValue {
  supplierInvoiceNo: string | null;
  supplierInvoiceDate: string | null;
  supplierInvoiceDueDate: string | null;
  supplierInvoiceCurrency: string | null;
  supplierInvoiceNet: number | null;
  supplierInvoiceVat: number | null;
  supplierInvoiceTotal: number | null;
}

const txt = (v: number | null) => (v === null ? '' : String(v).replace('.', ','));

/**
 * Račun dobavljača na narudžbenici (broj, datum, dospijeće, valuta, osnovica,
 * PDV, ukupno). Kad je roba zaprimljena, iz njega nastaje povezani ulazni račun
 * — trošak robe ostaje na primkama (ne knjiži se dvaput).
 */
export function OrderInvoiceForm({ orderId, initial, orderTotal, readOnly }: { orderId: string; initial: OrderInvoiceValue; orderTotal: number; readOnly: boolean }) {
  const [v, setV] = useState({
    no: initial.supplierInvoiceNo ?? '',
    date: initial.supplierInvoiceDate ?? '',
    due: initial.supplierInvoiceDueDate ?? '',
    cur: initial.supplierInvoiceCurrency ?? 'EUR',
    net: txt(initial.supplierInvoiceNet),
    vat: txt(initial.supplierInvoiceVat),
    total: txt(initial.supplierInvoiceTotal),
  });
  const { run, pending, error } = useAction(saveOrderInvoiceAction);
  const autoTotal = v.net ? r2(parseNumber(v.net) + (v.vat ? parseNumber(v.vat) : 0)) : null;
  return (
    <fieldset disabled={readOnly} className="space-y-3">
      <FormGrid cols={4}>
        <Field label="Broj računa dobavljača" className="sm:col-span-2">
          <Input value={v.no} onChange={(e) => setV({ ...v, no: e.target.value })} className="font-mono" />
        </Field>
        <Field label="Datum računa">
          <Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />
        </Field>
        <Field label="Dospijeće">
          <Input type="date" value={v.due} onChange={(e) => setV({ ...v, due: e.target.value })} />
        </Field>
        <Field label="Valuta">
          <Input value={v.cur} maxLength={3} onChange={(e) => setV({ ...v, cur: e.target.value.toUpperCase() })} className="font-mono" />
        </Field>
        <Field label="Osnovica" hint={v.net ? undefined : `Prazno = vrijednost narudžbenice (${String(orderTotal).replace('.', ',')})`}>
          <Input inputMode="decimal" value={v.net} onChange={(e) => setV({ ...v, net: e.target.value })} className="text-right" />
        </Field>
        <Field label="PDV" hint="Uvoz: 0 (plaća se na carini)">
          <Input inputMode="decimal" value={v.vat} onChange={(e) => setV({ ...v, vat: e.target.value })} className="text-right" placeholder="0" />
        </Field>
        <Field label="Ukupno">
          <Input inputMode="decimal" value={v.total} onChange={(e) => setV({ ...v, total: e.target.value })} className="text-right" placeholder={autoTotal === null ? '' : String(autoTotal).replace('.', ',')} />
        </Field>
      </FormGrid>
      <FormError error={error} />
      {!readOnly && (
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            loading={pending}
            onClick={() =>
              run({
                orderId,
                supplierInvoiceNo: v.no,
                supplierInvoiceDate: v.date,
                supplierInvoiceDueDate: v.due,
                supplierInvoiceCurrency: v.cur,
                supplierInvoiceNet: v.net,
                supplierInvoiceVat: v.vat,
                supplierInvoiceTotal: v.total,
              })
            }
          >
            Spremi račun dobavljača
          </Button>
        </div>
      )}
    </fieldset>
  );
}
