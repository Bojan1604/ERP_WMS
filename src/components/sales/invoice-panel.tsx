'use client';

import { useState } from 'react';
import { Ban, CheckCheck, FileMinus2, Trash2, Undo2 } from 'lucide-react';
import { ActionButton, ActionForm, FormError } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/misc';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { date, eur } from '@/lib/format';
import { today } from '@/domain/dates';
import {
  addInvoicePayment,
  creditNoteAction,
  deleteInvoicePayment,
  markInvoicePaid,
  markInvoiceUnpaid,
  stornoInvoiceAction,
} from '@/app/(app)/prodaja/racuni/actions';

export const PAYMENT_METHODS = ['Transakcijski račun', 'Gotovina', 'Kartica', 'Kompenzacija', 'Ostalo'];

export interface PanelInvoice {
  id: string;
  number: string | null;
  kind: 'INVOICE' | 'ADVANCE' | 'STORNO' | 'CREDIT_NOTE';
  stornoed: boolean;
  grandTotal: number;
  netTotal: number;
  paidTotal: number;
  creditedTotal: number;
  openAmount: number;
  vatRate: number;
  payments: Array<{ id: string; date: string; amount: number; method: string | null; note: string | null; createdBy: string | null }>;
}

/** Uplate: popis, nova uplata, plaćeno u cijelosti, vraćanje u neplaćeno. */
export function PaymentsCard({ inv, canEdit }: { inv: PanelInvoice; canEdit: boolean }) {
  const receivable = (inv.kind === 'INVOICE' || inv.kind === 'ADVANCE') && !inv.stornoed;
  return (
    <Card title="Naplata" padded={false}>
      <dl className="px-4 py-3 text-base">
        <Row k="Ukupno" v={eur(inv.grandTotal)} />
        {inv.creditedTotal > 0 && <Row k="Odobreno" v={eur(-inv.creditedTotal)} />}
        <Row k="Plaćeno" v={eur(inv.paidTotal)} />
        <Row k="Otvoreno" v={eur(inv.openAmount)} strong />
      </dl>
      {inv.payments.length > 0 && (
        <ul className="border-t border-line">
          {inv.payments.map((p) => (
            <li key={p.id} className="flex items-center gap-2 border-b border-line/70 px-4 py-2 last:border-0">
              <div className="min-w-0 flex-1">
                <p className="text-base">
                  <span className="tnum font-medium">{eur(p.amount)}</span> <span className="text-fg-3">· {date(p.date)}</span>
                </p>
                <p className="truncate text-xs text-fg-3">{[p.method, p.note, p.createdBy].filter(Boolean).join(' · ')}</p>
              </div>
              {canEdit && (
                <ActionButton
                  action={deleteInvoicePayment}
                  input={{ paymentId: p.id }}
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 className="size-3.5" />}
                  aria-label="Obriši uplatu"
                  confirm={`Obrisati uplatu od ${eur(p.amount)} (${date(p.date)})?`}
                  confirmLabel="Obriši"
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && receivable && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          {inv.openAmount > 0 && (
            <ActionForm action={addInvoicePayment} successMessage="Uplata je upisana." resetOnSuccess>
              {({ pending, error }) => (
                <div className="space-y-2">
                  <input type="hidden" name="invoiceId" value={inv.id} />
                  <p className="text-sm font-medium text-fg-2">Nova uplata</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Datum">
                      <Input type="date" name="date" defaultValue={today()} required />
                    </Field>
                    <Field label="Iznos €">
                      <Input name="amount" defaultValue={String(inv.openAmount).replace('.', ',')} inputMode="decimal" className="text-right" required key={inv.openAmount} />
                    </Field>
                  </div>
                  <Field label="Način">
                    <Select name="method" options={PAYMENT_METHODS.map((m) => ({ value: m, label: m }))} defaultValue={PAYMENT_METHODS[0]} />
                  </Field>
                  <Field label="Napomena">
                    <Input name="note" />
                  </Field>
                  <FormError error={error} />
                  <Button type="submit" variant="subtle" loading={pending} className="w-full">
                    Upiši uplatu
                  </Button>
                </div>
              )}
            </ActionForm>
          )}
          <div className="flex flex-wrap gap-2">
            {inv.openAmount > 0 && (
              <ActionButton action={markInvoicePaid} input={{ invoiceId: inv.id, date: today() }} variant="primary" size="sm" icon={<CheckCheck className="size-3.5" />}>
                Plaćeno u cijelosti
              </ActionButton>
            )}
            {inv.payments.length > 0 && (
              <ActionButton
                action={markInvoiceUnpaid}
                input={{ invoiceId: inv.id }}
                size="sm"
                variant="secondary"
                icon={<Undo2 className="size-3.5" />}
                confirmTitle="Vrati u neplaćeno"
                confirm="Sve uplate na ovom računu bit će obrisane, a račun će ponovno biti otvoren. Nastaviti?"
                confirmLabel="Vrati u neplaćeno"
              >
                Vrati u neplaćeno
              </ActionButton>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={strong ? 'mt-1 flex justify-between border-t border-line pt-1.5 font-semibold' : 'flex justify-between py-0.5'}>
      <dt className={strong ? '' : 'text-fg-3'}>{k}</dt>
      <dd className="tnum">{v}</dd>
    </div>
  );
}

/** Storno (cijeli račun) i knjižno odobrenje (dio iznosa). */
export function CorrectionButtons({ inv }: { inv: PanelInvoice }) {
  const [open, setOpen] = useState<'storno' | 'credit' | null>(null);
  const valid = (inv.kind === 'INVOICE' || inv.kind === 'ADVANCE') && !inv.stornoed;
  if (!valid) return null;
  const maxNet = Math.max(0, Math.round((inv.netTotal - inv.creditedTotal / (1 + inv.vatRate / 100)) * 100) / 100);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<Ban className="size-3.5" />} onClick={() => setOpen('storno')}>
          Storno
        </Button>
        {inv.kind === 'INVOICE' && (
          <Button size="sm" variant="secondary" icon={<FileMinus2 className="size-3.5" />} onClick={() => setOpen('credit')}>
            Odobrenje
          </Button>
        )}
      </div>

      <Dialog open={open === 'storno'} onClose={() => setOpen(null)} title={`Storno računa ${inv.number}`} size="sm">
        <ActionForm action={stornoInvoiceAction} successMessage="Storno je izdan." onSuccess={() => setOpen(null)}>
          {({ pending, error }) => (
            <div className="space-y-3">
              <input type="hidden" name="invoiceId" value={inv.id} />
              <p className="text-base text-fg-2">
                Izdaje se novi dokument s negativnim iznosima koji poništava cijeli račun. Izvorni račun ostaje u evidenciji kao storniran, a prodani uređaji
                vraćaju se na skladište.
              </p>
              {inv.paidTotal > 0 && <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">Račun ima uplate — prije storna ih treba obrisati.</p>}
              <Field label="Datum storna">
                <Input type="date" name="date" defaultValue={today()} />
              </Field>
              <Field label="Razlog (neobavezno)">
                <Input name="reason" placeholder="npr. pogrešan kupac" />
              </Field>
              <FormError error={error} />
              <div className="flex justify-end gap-2">
                <Button onClick={() => setOpen(null)}>Odustani</Button>
                <Button type="submit" variant="danger" loading={pending}>
                  Izdaj storno
                </Button>
              </div>
            </div>
          )}
        </ActionForm>
      </Dialog>

      <Dialog open={open === 'credit'} onClose={() => setOpen(null)} title={`Knjižno odobrenje na račun ${inv.number}`} size="sm">
        <ActionForm action={creditNoteAction} successMessage="Odobrenje je izdano." onSuccess={() => setOpen(null)}>
          {({ pending, error }) => (
            <div className="space-y-3">
              <input type="hidden" name="invoiceId" value={inv.id} />
              <p className="text-base text-fg-2">Odobrenje umanjuje dio iznosa računa; izvorni račun ostaje važeći. PDV se obračunava po stopi računa ({inv.vatRate} %).</p>
              <Field label="Opis" required>
                <Input name="description" placeholder="npr. Popust zbog oštećenja ambalaže" required />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Iznos bez PDV-a €" hint={`Najviše ${eur(maxNet)}`} required>
                  <Input name="netAmount" inputMode="decimal" className="text-right" required />
                </Field>
                <Field label="Datum">
                  <Input type="date" name="date" defaultValue={today()} />
                </Field>
              </div>
              <FormError error={error} />
              <div className="flex justify-end gap-2">
                <Button onClick={() => setOpen(null)}>Odustani</Button>
                <Button type="submit" variant="primary" loading={pending}>
                  Izdaj odobrenje
                </Button>
              </div>
            </div>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}
