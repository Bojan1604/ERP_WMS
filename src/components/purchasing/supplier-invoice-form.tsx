'use client';

import { useEffect, useState } from 'react';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Card } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { supplierVat } from '@/domain/tax';
import { r2 } from '@/domain/money';
import { vatPctOf } from '@/domain/purchase-links';
import { supplierDocsAction } from '@/app/(app)/nabava/ulazni/actions';

export interface SupplierInvoiceValue {
  id: string | null;
  internalNo: string | null;
  supplierId: string | null;
  /** Slobodni unos dobavljača (kad nije odabran partner). */
  supplierName: string | null;
  supplierOib: string | null;
  number: string;
  issueDate: string;
  dueDate: string | null;
  netAmount: number;
  vatAmount: number;
  total: number;
  vatPct: number | null;
  currency: string;
  category: string | null;
  note: string | null;
  paidDate: string | null;
  book: boolean;
  orderId: string | null;
  receiptId: string | null;
}

type SaveInput = Omit<SupplierInvoiceValue, 'internalNo'>;

/** Ono što se o vezi s nabavom zna unaprijed (za prikaz odabranog). */
export interface LinkOptions {
  order: ComboOption | null;
  receipt: ComboOption | null;
}

/**
 * Unos i izmjena ulaznog računa; PDV se predlaže po državi dobavljača.
 * Dobavljač se bira među partnerima ili upisuje slobodno (naziv + OIB) — tada
 * se partner otvara pri spremanju. Veza s narudžbenicom/primkom: trošak robe
 * koji je knjižen primkom račun ne knjiži ponovno.
 * eRačun: dobavljač, broj, datum i iznosi dolaze iz XML-a i ne mijenjaju se
 * (`lockDocument`); odbijeni račun se ne plaća ni knjiži (`rejected`);
 * zaprimljeni eRačun se ne plaća prije prihvaćanja (`payLocked`); `readOnly` za korisnike bez prava izmjene.
 */
export function SupplierInvoiceForm({
  initial,
  suppliers,
  categories,
  company,
  action,
  links,
  lockDocument = false,
  rejected = false,
  payLocked = false,
  readOnly = false,
  bookedByReceipt = false,
}: {
  initial: SupplierInvoiceValue;
  suppliers: Array<{ value: string; label: string; country: string }>;
  categories: string[];
  company: { vatRate: number; country: string };
  action: ServerAction<SaveInput, { warning?: string | null } | unknown>;
  links?: LinkOptions;
  lockDocument?: boolean;
  rejected?: boolean;
  payLocked?: boolean;
  readOnly?: boolean;
  /** Trošak robe je knjižen primkom (povezana primka/narudžbenica). */
  bookedByReceipt?: boolean;
}) {
  const [v, setV] = useState(initial);
  const [free, setFree] = useState(!initial.supplierId && !!(initial.supplierName || initial.supplierOib));
  const [vatTouched, setVatTouched] = useState(!!initial.id);
  const [totalTouched, setTotalTouched] = useState(!!initial.id && r2(initial.netAmount + initial.vatAmount) !== initial.total);
  const [localError, setLocalError] = useState<string | null>(null);
  const [docs, setDocs] = useState<{ orders: ComboOption[]; receipts: Array<ComboOption & { orderId: string | null }> }>({
    orders: links?.order ? [links.order] : [],
    receipts: links?.receipt ? [{ ...links.receipt, orderId: null }] : [],
  });
  const toast = useToast();
  const { run, pending, error } = useAction(action, {
    onSuccess: (d) => {
      const w = (d as { warning?: string | null } | undefined)?.warning;
      if (w) toast('bad', w);
    },
  });

  // narudžbenice i primke odabranog dobavljača (za vezu s nabavom)
  useEffect(() => {
    if (!v.supplierId || free) return;
    let live = true;
    void supplierDocsAction({ supplierId: v.supplierId }).then((r) => {
      if (live && r.ok && r.data) setDocs(r.data);
    });
    return () => {
      live = false;
    };
  }, [v.supplierId, free]);

  const supplier = suppliers.find((s) => s.value === v.supplierId);
  const vatInfo = supplierVat(free ? company.country : supplier?.country, company);
  const recompute = (patch: Partial<SupplierInvoiceValue>, s = v, country = supplier?.country) => {
    const next = { ...s, ...patch };
    if (!vatTouched) next.vatAmount = r2((next.netAmount * supplierVat(country, company).rate) / 100);
    if (!totalTouched) next.total = r2(next.netAmount + next.vatAmount);
    setV(next);
  };
  const linked = !!(v.orderId || v.receiptId);

  const submit = () => {
    if (!free && !v.supplierId) return setLocalError('Odaberite dobavljača ili ga upišite slobodno (naziv i OIB).');
    if (free && !v.supplierName?.trim()) return setLocalError('Upišite naziv dobavljača.');
    if (!v.number.trim()) return setLocalError('Upišite broj računa dobavljača.');
    setLocalError(null);
    const { internalNo: _ignored, ...rest } = v;
    void _ignored;
    run(free ? { ...rest, supplierId: null } : { ...rest, supplierName: null, supplierOib: null });
  };

  return (
    <div className="space-y-4">
      <Card title={v.internalNo ? `Ulazni račun ${v.internalNo}` : 'Novi ulazni račun'}>
        <fieldset disabled={readOnly} className="contents">
          <FormGrid cols={4}>
            {free ? (
              <>
                <Field label="Naziv dobavljača" required hint="Dobavljač se otvara u partnerima pri spremanju">
                  <Input value={v.supplierName ?? ''} onChange={(e) => setV({ ...v, supplierName: e.target.value })} />
                </Field>
                <Field label="OIB dobavljača">
                  <Input value={v.supplierOib ?? ''} inputMode="numeric" maxLength={13} onChange={(e) => setV({ ...v, supplierOib: e.target.value.trim() })} className="font-mono" />
                </Field>
              </>
            ) : (
              <Field label="Dobavljač" required className="sm:col-span-2">
                <Combobox
                  options={suppliers.map((s) => ({ value: s.value, label: s.label, hint: s.country !== company.country ? s.country : undefined }))}
                  value={v.supplierId}
                  onChange={(id) => {
                    const c = suppliers.find((s) => s.value === id)?.country;
                    recompute({ supplierId: id, orderId: null, receiptId: null }, v, c);
                  }}
                  placeholder="Odaberite dobavljača…"
                  disabled={lockDocument || readOnly}
                />
              </Field>
            )}
            <Field label="Broj računa dobavljača" required>
              <Input value={v.number} disabled={lockDocument} onChange={(e) => setV({ ...v, number: e.target.value })} />
            </Field>
            <Field label="Interni broj" hint={v.internalNo ? undefined : 'Dodjeljuje se pri spremanju'}>
              <Input value={v.internalNo ?? ''} disabled placeholder="URA-…" />
            </Field>
            {!lockDocument && !readOnly && (
              <div className="sm:col-span-4 -mt-1">
                <button
                  type="button"
                  className="text-sm text-brand hover:underline"
                  onClick={() => {
                    setFree(!free);
                    setV({ ...v, supplierId: free ? v.supplierId : null, orderId: null, receiptId: null });
                  }}
                >
                  {free ? 'Odaberi dobavljača iz partnera' : 'Dobavljača nema u partnerima? Upiši naziv i OIB'}
                </button>
              </div>
            )}
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
                disabled={lockDocument || readOnly}
                onChange={(e) => {
                  setVatTouched(true);
                  const vat = Number(e.target.value);
                  setV({ ...v, vatAmount: vat, total: totalTouched ? v.total : r2(v.netAmount + vat) });
                }}
              />
            </Field>
            <Field label="PDV %" hint={v.vatPct === null ? `Iz iznosa: ${vatPctOf(v.netAmount, v.vatAmount) ?? '—'} %` : undefined}>
              <Input
                inputMode="decimal"
                value={v.vatPct ?? ''}
                disabled={readOnly}
                onChange={(e) => {
                  const pct = e.target.value === '' ? null : Number(e.target.value.replace(',', '.'));
                  const next = { ...v, vatPct: pct };
                  if (pct !== null && Number.isFinite(pct) && !lockDocument) {
                    next.vatAmount = r2((v.netAmount * pct) / 100);
                    if (!totalTouched) next.total = r2(v.netAmount + next.vatAmount);
                    setVatTouched(true);
                  }
                  setV(next);
                }}
              />
            </Field>
            <Field label="Ukupno">
              <Input
                type="number"
                step="0.01"
                value={v.total}
                disabled={lockDocument || readOnly}
                onChange={(e) => {
                  setTotalTouched(true);
                  setV({ ...v, total: Number(e.target.value) });
                }}
              />
            </Field>
            <Field label="Valuta">
              <Input value={v.currency} maxLength={3} disabled={lockDocument} onChange={(e) => setV({ ...v, currency: e.target.value.toUpperCase() })} className="font-mono" />
            </Field>
            <Field label="Plaćeno dana" hint={payLocked && !v.paidDate ? 'Plaća se nakon prihvaćanja eRačuna' : 'Prazno = nije plaćeno'}>
              <Input type="date" value={v.paidDate ?? ''} disabled={rejected || (payLocked && !v.paidDate)} onChange={(e) => setV({ ...v, paidDate: e.target.value || null })} />
            </Field>
            {!free && (
              <>
                <Field label="Narudžbenica" className="sm:col-span-2" hint="Veza s nabavom — trošak robe se ne knjiži dvaput">
                  <Combobox options={docs.orders} value={v.orderId} onChange={(id) => setV({ ...v, orderId: id })} placeholder="— bez narudžbenice —" allowEmpty disabled={readOnly || !v.supplierId} />
                </Field>
                <Field label="Primka" className="sm:col-span-2">
                  <Combobox
                    options={docs.receipts}
                    value={v.receiptId}
                    onChange={(id) => {
                      const r = docs.receipts.find((x) => x.value === id);
                      setV({ ...v, receiptId: id, orderId: v.orderId ?? r?.orderId ?? null });
                    }}
                    placeholder="— bez primke —"
                    allowEmpty
                    disabled={readOnly || !v.supplierId}
                  />
                </Field>
              </>
            )}
            <Field label="Napomena" className="sm:col-span-4">
              <Textarea rows={2} value={v.note ?? ''} onChange={(e) => setV({ ...v, note: e.target.value })} />
            </Field>
          </FormGrid>
          <div className="mt-3">
            {bookedByReceipt ? (
              <p className="text-sm text-fg-2">Trošak robe knjižen je primkom — račun ga ne knjiži ponovno.</p>
            ) : (
              <>
                <Checkbox label="Knjiži kao trošak" checked={v.book} disabled={rejected} onChange={(e) => setV({ ...v, book: e.target.checked })} />
                <p className="mt-1 text-xs text-fg-3">
                  {linked
                    ? 'Ako povezana primka ima knjižen trošak nabave, račun ne knjiži vlastiti trošak (trošak se ne zbraja dvaput).'
                    : 'Za račun robe koja je zaprimljena primkom povežite primku ili narudžbenicu — trošak je tada već knjižen primkom.'}
                </p>
              </>
            )}
            {lockDocument && <p className="mt-1 text-xs text-fg-3">Dobavljač, broj, datum i iznosi eRačuna preuzeti su iz XML-a i ne mijenjaju se.</p>}
          </div>
        </fieldset>
      </Card>
      {!readOnly && (
        <>
          <FormError error={localError ?? error} />
          <div className="flex justify-end gap-2">
            <LinkButton href="/nabava/ulazni">Odustani</LinkButton>
            <Button variant="primary" loading={pending} onClick={submit}>
              Spremi
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
