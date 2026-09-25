'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Attachments } from '@/components/ui/attachments';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { PartnerCombobox } from '@/components/partners/partner-combobox';
import type { PartnerOpt } from '@/lib/partner-option';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';
import { FREQUENCY_LABEL, type FrequencyCode } from '@/domain/expenses';
import { periodLabel } from '@/domain/dates';
import { r2 } from '@/domain/money';
import { supplierVat } from '@/domain/tax';
import { eur } from '@/lib/format';
import { cn } from '@/lib/cn';

export interface ExpenseValue {
  id: string | null;
  date: string;
  categoryId: string | null;
  description: string;
  partnerId: string | null;
  netAmount: number;
  vatAmount: number;
  paid: boolean;
  frequency: FrequencyCode | null;
  recurringUntil: string | null;
  note: string | null;
  overrides: Record<string, { amount?: number; skipped?: boolean }>;
}

export interface ExpenseActions {
  save: ServerAction<Omit<ExpenseValue, 'overrides'>>;
  remove: ServerAction<{ id: string }>;
  occurrence: ServerAction<{ id: string; period: string; amount: number | null; skipped: boolean }>;
}

export interface ExpenseOptions {
  categories: Array<{ value: string; label: string }>;
  /** Partneri prikazanih troškova (odabir ostalih ide pretragom na poslužitelju). */
  partners: PartnerOpt[];
  company: { vatRate: number; country: string };
}

/**
 * Unos i izmjena troška. Za ponavljajući trošak otvoren iz tablice nudi
 * izmjenu samo te rate (iznos ili preskakanje) ili cijelog niza.
 */
export function ExpenseDialog({
  open,
  onClose,
  value,
  period,
  options,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  value: ExpenseValue;
  period?: string | null;
  options: ExpenseOptions;
  actions: ExpenseActions;
}) {
  const recurringOccurrence = !!(value.id && value.frequency && period);
  const [tab, setTab] = useState<'one' | 'all'>(recurringOccurrence ? 'one' : 'all');
  const [v, setV] = useState(value);
  const [vatTouched, setVatTouched] = useState(!!value.id);
  const ov = period ? value.overrides[period] : undefined;
  const [amount, setAmount] = useState<number>(ov?.amount ?? value.netAmount);
  const save = useAction(actions.save, { onSuccess: onClose });
  const remove = useAction(actions.remove, { onSuccess: onClose });
  const occ = useAction(actions.occurrence, { onSuccess: onClose });

  const [picked, setPicked] = useState<PartnerOpt | null>(options.partners.find((p) => p.id === value.partnerId) ?? null);
  const vatRateFor = (partnerId: string | null, known: PartnerOpt | null = picked) => {
    const p = known?.id === partnerId ? known : null;
    return supplierVat(p?.country ?? options.company.country, options.company).rate;
  };
  const update = (patch: Partial<ExpenseValue>, known: PartnerOpt | null = picked) => {
    const next = { ...v, ...patch };
    if (!vatTouched) next.vatAmount = r2((next.netAmount * vatRateFor(next.partnerId, known)) / 100);
    setV(next);
  };
  const skipped = Object.entries(value.overrides).filter(([, o]) => o.skipped);

  const footer =
    tab === 'one' && period && value.id ? (
      <>
        {ov && (
          <Button onClick={() => occ.run({ id: value.id!, period, amount: null, skipped: false })} loading={occ.pending} className="mr-auto">
            Vrati na zadano
          </Button>
        )}
        <Button variant="danger" onClick={() => occ.run({ id: value.id!, period, amount: null, skipped: true })} loading={occ.pending}>
          Preskoči ovu ratu
        </Button>
        <Button variant="primary" onClick={() => occ.run({ id: value.id!, period, amount, skipped: false })} loading={occ.pending}>
          Spremi ratu
        </Button>
      </>
    ) : (
      <>
        {value.id && (
          <Button variant="ghost" className="mr-auto text-bad-strong" loading={remove.pending} onClick={() => confirm('Obrisati trošak (sve rate)?') && remove.run({ id: value.id! })}>
            Obriši
          </Button>
        )}
        <Button onClick={onClose}>Odustani</Button>
        <Button
          variant="primary"
          loading={save.pending}
          onClick={() => {
            const { overrides: _o, ...rest } = v;
            void _o;
            save.run(rest);
          }}
        >
          Spremi
        </Button>
      </>
    );

  return (
    <Dialog open={open} onClose={onClose} title={value.id ? value.description : 'Novi trošak'} size="lg" footer={footer}>
      {recurringOccurrence && (
        <div className="mb-4 inline-flex rounded-md bg-muted p-0.5">
          {(
            [
              ['one', `Samo rata ${periodLabel(period!)}`],
              ['all', 'Cijeli niz'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn('h-7 rounded px-2.5 text-sm', tab === k ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-3 hover:text-fg')}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === 'one' && period ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-3">
            Izmjena vrijedi samo za ratu {periodLabel(period)}; ostale rate ostaju {eur(value.netAmount)} bez PDV-a. PDV se preračunava razmjerno.
          </p>
          <Field label="Iznos rate bez PDV-a">
            <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} autoFocus />
          </Field>
          <FormError error={occ.error} />
        </div>
      ) : (
        <div className="space-y-3">
          <FormGrid cols={4}>
            <Field label={v.frequency ? 'Prva rata' : 'Datum'} required>
              <Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />
            </Field>
            <Field label="Kategorija">
              <Select placeholder="— bez kategorije —" options={options.categories} value={v.categoryId ?? ''} onChange={(e) => setV({ ...v, categoryId: e.target.value || null })} />
            </Field>
            <Field label="Opis" required className="sm:col-span-2">
              <Input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
            </Field>
            <Field label="Dobavljač / partner" className="sm:col-span-2">
              <PartnerCombobox
                allowEmpty
                role="expense"
                initial={picked}
                value={v.partnerId}
                onChange={(id, p) => {
                  setPicked(p ?? null);
                  update({ partnerId: id }, p ?? null);
                }}
                placeholder="— bez partnera —"
              />
            </Field>
            <Field label="Iznos bez PDV-a" required>
              <Input type="number" step="0.01" value={v.netAmount} onChange={(e) => update({ netAmount: Number(e.target.value) })} />
            </Field>
            <Field label="PDV" hint={vatTouched ? 'Upisano ručno' : `${vatRateFor(v.partnerId)} % prema državi partnera`}>
              <Input
                type="number"
                step="0.01"
                value={v.vatAmount}
                onChange={(e) => {
                  setVatTouched(true);
                  setV({ ...v, vatAmount: Number(e.target.value) });
                }}
              />
            </Field>
            <Field label="Ponavljanje">
              <Select
                placeholder="Jednokratno"
                options={Object.entries(FREQUENCY_LABEL).map(([value, label]) => ({ value, label }))}
                value={v.frequency ?? ''}
                onChange={(e) => setV({ ...v, frequency: (e.target.value || null) as FrequencyCode | null })}
              />
            </Field>
            {v.frequency && (
              <Field label="Ponavljaj do" hint="Prazno = bez kraja">
                <Input type="date" value={v.recurringUntil ?? ''} onChange={(e) => setV({ ...v, recurringUntil: e.target.value || null })} />
              </Field>
            )}
            <div className={cn('flex items-end pb-1.5', v.frequency ? 'sm:col-span-2' : 'sm:col-span-3')}>
              <Checkbox label="Plaćeno" checked={v.paid} onChange={(e) => setV({ ...v, paid: e.target.checked })} />
            </div>
            <Field label="Napomena" className="sm:col-span-4">
              <Textarea rows={2} value={v.note ?? ''} onChange={(e) => setV({ ...v, note: e.target.value })} />
            </Field>
          </FormGrid>
          <p className="text-sm text-fg-3">
            Ukupno s PDV-om: <b className="text-fg">{eur(r2(v.netAmount + v.vatAmount))}</b>
            {v.frequency && ` po rati (${FREQUENCY_LABEL[v.frequency].toLowerCase()})`}
          </p>
          {value.id && skipped.length > 0 && (
            <div className="rounded-md bg-panel-2 p-2.5 text-sm">
              <p className="mb-1 text-fg-3">Preskočene rate:</p>
              <div className="flex flex-wrap gap-1.5">
                {skipped.map(([p]) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => occ.run({ id: value.id!, period: p, amount: null, skipped: false })}
                    className="rounded border border-line-strong px-2 py-0.5 hover:bg-muted"
                    title="Vrati ratu"
                  >
                    {periodLabel(p)} ↺
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="mb-1 text-sm font-medium text-fg-2">Priloženi račun (PDF ili slika)</p>
            {value.id ? (
              <Attachments entity="expense" id={value.id} canEdit empty="Nema priloga." />
            ) : (
              <p className="text-sm text-fg-3">Prilog se dodaje nakon spremanja troška.</p>
            )}
          </div>
          <FormError error={save.error ?? remove.error} />
        </div>
      )}
    </Dialog>
  );
}
