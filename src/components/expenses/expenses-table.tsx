'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Paperclip, Plus, Repeat } from 'lucide-react';
import { Badge, Empty } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { ActionButton, type ServerAction } from '@/components/ui/action';
import { FREQUENCY_LABEL, type FrequencyCode } from '@/domain/expenses';
import { today } from '@/domain/dates';
import { date, eur, integer } from '@/lib/format';
import { EXPENSE_SOURCE, type ExpenseSourceCode } from './labels';
import { ExpenseDialog, type ExpenseActions, type ExpenseOptions, type ExpenseValue } from './expense-dialog';
import { countLabel } from '@/domain/plural';

export interface OccurrenceRow {
  key: string;
  expenseId: string;
  date: string;
  period: string;
  netAmount: number;
  vatAmount: number;
  total: number;
  overridden: boolean;
  description: string;
  paid: boolean;
  frequency: string | null;
  source: ExpenseSourceCode;
  category: string | null;
  partner: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
  supplierInvoiceId: string | null;
  supplierInvoiceNo: string | null;
}

const blank = (): ExpenseValue => ({
  id: null,
  date: today(),
  categoryId: null,
  description: '',
  partnerId: null,
  netAmount: 0,
  vatAmount: 0,
  paid: false,
  frequency: null,
  recurringUntil: null,
  note: null,
  overrides: {},
});

function sourceLink(r: OccurrenceRow) {
  if (r.source === 'RECEIPT' && r.receiptId) return { href: `/nabava/primke/${r.receiptId}`, label: r.receiptNumber ?? 'primka' };
  if (r.source === 'SUPPLIER_INVOICE' && r.supplierInvoiceId) return { href: `/nabava/ulazni/${r.supplierInvoiceId}`, label: r.supplierInvoiceNo ?? 'ulazni račun' };
  return null;
}

/** Gumb „Novi trošak" s obrascem. */
export function NewExpenseButton({ options, actions }: { options: ExpenseOptions; actions: ExpenseActions }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
        Novi trošak
      </Button>
      {open && <ExpenseDialog open onClose={() => setOpen(false)} value={blank()} options={options} actions={actions} />}
    </>
  );
}

/** Tablica rata troškova; ručni troškovi se otvaraju klikom, ostali vode na izvorni dokument. */
export function ExpensesTable({
  rows,
  manual,
  totals,
  options,
  actions,
  paidAction,
  canEdit,
  attachments = {},
  count,
}: {
  rows: OccurrenceRow[];
  manual: Record<string, ExpenseValue>;
  totals: { net: number; vat: number };
  options: ExpenseOptions;
  actions: ExpenseActions;
  /** Plaćeno/neplaćeno za troškove primki i otpisa (ulazni račun se plaća na računu, ručni u obrascu). */
  paidAction: ServerAction<{ ids: string[]; paid: boolean }, unknown>;
  canEdit: boolean;
  /** Broj priloga po trošku (oznaka spajalice). */
  attachments?: Record<string, number>;
  /** Ukupan broj rata kad je prikazana samo jedna stranica. */
  count?: number;
}) {
  const [edit, setEdit] = useState<{ value: ExpenseValue; period: string | null } | null>(null);
  if (!rows.length) return <Empty title="Nema troškova za zadane filtre" description="Nabava se knjiži sama iz primki, ostalo upisujete ovdje." />;
  return (
    <>
      <table className="data-table sm:min-w-[1100px]">
        <thead>
          <tr>
            <th>Datum</th>
            <th>Kategorija</th>
            <th>Opis</th>
            <th>Partner</th>
            <th className="num">Neto</th>
            <th className="num">PDV</th>
            <th className="num">Ukupno</th>
            <th>Plaćeno</th>
            <th>Izvor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const m = manual[r.expenseId];
            const link = sourceLink(r);
            const clickable = canEdit && !!m;
            return (
              <tr
                key={r.key}
                onClick={clickable ? () => setEdit({ value: m, period: r.frequency ? r.period : null }) : undefined}
                className={clickable ? 'cursor-pointer' : undefined}
              >
                <td className="whitespace-nowrap">{date(r.date)}</td>
                <td className="text-fg-2">{r.category ?? '—'}</td>
                <td>
                  <span className="inline-flex items-center gap-1.5">
                    {r.frequency && (
                      <span title={`Ponavljajući — ${FREQUENCY_LABEL[r.frequency as FrequencyCode].toLowerCase()}`}>
                        <Repeat className="size-3.5 text-info" />
                      </span>
                    )}
                    {r.description}
                    {r.overridden && <Badge tone="warn">izmijenjena rata</Badge>}
                    {(attachments[r.expenseId] ?? 0) > 0 && (
                      <span title={`Priloga: ${attachments[r.expenseId]}`} className="inline-flex items-center text-fg-3">
                        <Paperclip className="size-3.5" />
                      </span>
                    )}
                  </span>
                </td>
                <td className="max-w-48 truncate">{r.partner ?? '—'}</td>
                <td className="num">{eur(r.netAmount)}</td>
                <td className="num">{eur(r.vatAmount)}</td>
                <td className="num font-medium">{eur(r.total)}</td>
                <td className="whitespace-nowrap">
                  {r.paid ? <Badge tone="ok">da</Badge> : <Badge tone="warn">ne</Badge>}
                  {canEdit && (r.source === 'RECEIPT' || r.source === 'WRITE_OFF') && (
                    <span className="ml-1.5" onClick={(e) => e.stopPropagation()}>
                      <ActionButton
                        action={paidAction}
                        input={{ ids: [r.expenseId], paid: !r.paid }}
                        size="sm"
                        variant="ghost"
                        title={r.paid ? 'Označi trošak kao neplaćen' : 'Označi trošak kao plaćen (danas)'}
                      >
                        {r.paid ? 'poništi' : 'plaćeno'}
                      </ActionButton>
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  <Badge tone={EXPENSE_SOURCE[r.source].tone}>{EXPENSE_SOURCE[r.source].label}</Badge>
                  {link && (
                    <Link prefetch={false} href={link.href} onClick={(e) => e.stopPropagation()} className="link ml-1.5 text-sm">
                      {link.label}
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4}>Ukupno: {countLabel(count ?? rows.length, 'stavka', 'stavke', 'stavki', integer)}</td>
            <td className="num">{eur(totals.net)}</td>
            <td className="num">{eur(totals.vat)}</td>
            <td className="num">{eur(Math.round((totals.net + totals.vat) * 100) / 100)}</td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
      {edit && (
        <ExpenseDialog
          key={`${edit.value.id}-${edit.period}`}
          open
          onClose={() => setEdit(null)}
          value={edit.value}
          period={edit.period}
          options={options}
          actions={actions}
        />
      )}
    </>
  );
}
