'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, COLOR_TONE } from '@/components/ui/misc';
import { useAction } from '@/components/ui/action';
import { MONTHS_SHORT } from '@/domain/dates';
import { parseNumber } from '@/domain/money';
import { amount, date, eur, integer } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { OverviewRow, OverviewTotals } from '@/app/(app)/najam/pregled/data';
import { rentOverrideAction } from '@/app/(app)/najam/pregled/actions';

/**
 * Mreža najma kao u Excelu: dvoklik na ćeliju upisuje ručni iznos (Enter
 * sprema, Esc odustaje, prazno briše ručni upis). Ručni upisi su podebljani.
 */
export function OverviewGrid({
  year,
  rows,
  totals,
  currentMonth,
  canEdit,
}: {
  year: number;
  rows: OverviewRow[];
  totals: OverviewTotals;
  currentMonth: number;
  canEdit: boolean;
}) {
  const [edit, setEdit] = useState<{ itemId: string; m: number; value: string } | null>(null);
  const save = useAction(rentOverrideAction, { onSuccess: () => setEdit(null) });
  const hl = (m: number) => m === currentMonth && 'bg-info-soft';
  const future = (m: number) => currentMonth >= 0 && m > currentMonth;

  const commit = () => {
    if (!edit) return;
    const v = edit.value.trim();
    save.run({ itemId: edit.itemId, year, month: edit.m + 1, amount: v === '' ? null : parseNumber(v) });
  };

  return (
    <div className="overflow-x-auto scroll-slim rounded-lg bg-panel shadow-[var(--shadow-panel)]">
      <table className="data-table compact [&_td]:whitespace-nowrap">
        <thead>
          <tr>
            <th className="sticky left-0 z-[2] w-40 min-w-40 max-w-40 bg-panel-2">Klijent</th>
            <th className="sticky left-40 z-[2] bg-panel-2">Serijski</th>
            <th>Ugovor</th>
            <th>Model</th>
            <th>Kategorija</th>
            <th>Status</th>
            <th className="num">Mjesečno</th>
            {MONTHS_SHORT.map((m, i) => (
              <th key={m} className={cn('num min-w-16', hl(i))}>
                {m}
              </th>
            ))}
            <th className="num">Ukupno</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.itemId}>
              <td className="sticky left-0 z-[1] w-40 min-w-40 max-w-40 truncate bg-panel" title={r.partner ?? ''}>
                {r.partner ?? <span className="text-fg-4">—</span>}
              </td>
              <td className="sticky left-40 z-[1] bg-panel">
                <Link prefetch={false} href={`/skladiste/${r.itemId}`} className="link font-mono text-sm">
                  {r.serial}
                </Link>
                {r.from && (
                  <Badge className="ml-1.5" tone="info" title="Naplata počinje kasnije">
                    od {date(r.from)}
                  </Badge>
                )}
              </td>
              <td className="text-sm">
                {r.contract ? (
                  <Link prefetch={false} href={`/najam/ugovori/${r.contract.id}`} className="link">
                    {r.contract.number}
                  </Link>
                ) : (
                  <span className="text-fg-4">—</span>
                )}
              </td>
              <td className="max-w-44 truncate" title={r.model}>{r.model}</td>
              <td className="text-fg-2">{r.category ?? '—'}</td>
              <td>
                <Badge tone={COLOR_TONE[r.status.color] ?? 'neutral'}>{r.status.name}</Badge>
              </td>
              <td className="num">{r.monthly ? amount(r.monthly) : ''}</td>
              {r.cells.map((c, m) => {
                const editing = edit?.itemId === r.itemId && edit.m === m;
                return (
                  <td
                    key={m}
                    className={cn('num select-none', hl(m), future(m) && !c.manual && 'bg-panel-2/60', c.manual && 'font-bold', canEdit && 'cursor-cell')}
                    title={c.manual ? 'Ručni upis — dvoklik za izmjenu, prazno vraća izračun' : canEdit ? 'Dvoklik za ručni upis' : undefined}
                    onDoubleClick={() => canEdit && setEdit({ itemId: r.itemId, m, value: c.manual && c.v !== null ? String(c.v).replace('.', ',') : '' })}
                  >
                    {editing ? (
                      <input
                        autoFocus
                        aria-label="Ručni iznos"
                        value={edit.value}
                        disabled={save.pending}
                        onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commit();
                          if (e.key === 'Escape') setEdit(null);
                        }}
                        onBlur={() => !save.pending && setEdit(null)}
                        placeholder="auto"
                        className="h-6 w-20 rounded border border-brand bg-panel px-1 text-right text-sm focus:outline-none"
                      />
                    ) : c.v ? (
                      amount(c.v)
                    ) : (
                      ''
                    )}
                  </td>
                );
              })}
              <td className="num font-medium">{r.total ? amount(r.total) : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="sticky left-0 z-[1]" colSpan={2}>
              {integer(totals.devices)} uređaja
            </td>
            <td colSpan={4} />
            <td className="num">{amount(totals.monthly)}</td>
            {totals.months.map((v, m) => (
              <td key={m} className={cn('num', hl(m))}>
                {v ? amount(v) : ''}
              </td>
            ))}
            <td className="num">{amount(totals.collected)}</td>
          </tr>
          <tr>
            <td colSpan={21} className="font-normal">
              <span className="mr-6">
                Naplaćeno do sada: <b>{eur(totals.collected)}</b>
              </span>
              <span className="mr-6">
                Planirano do kraja godine: <b>{eur(totals.planned)}</b>
              </span>
              <span className="text-fg-3">Ukupno za godinu: {eur(totals.collected + totals.planned)}</span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
