'use client';

import { useEffect, useRef, useState } from 'react';
import { Eraser, PenLine, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Badge, COLOR_TONE } from '@/components/ui/misc';
import { useAction } from '@/components/ui/action';
import { MONTHS_SHORT } from '@/domain/dates';
import { parseNumber } from '@/domain/money';
import { amount, date, eur, integer } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { OverviewRow, OverviewTotals } from '@/app/(app)/najam/pregled/data';
import { rentOverrideAction, rentOverridesBulkAction } from '@/app/(app)/najam/pregled/actions';

const key = (itemId: string, m: number) => `${itemId}:${m}`;

/**
 * Mreža najma kao u Excelu: dvoklik na ćeliju upisuje ručni iznos (Enter
 * sprema, Esc odustaje, prazno briše ručni upis). Ručni upisi su podebljani.
 * Povlačenjem mišem označava se više polja (Shift dodaje) — zatim „Upiši"
 * isti iznos, „Auto" (briše ručne upise) ili „Odznači".
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
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkValue, setBulkValue] = useState('');
  const drag = useRef<{ row: number; m: number; base: Set<string> } | null>(null);
  const bulk = useAction(rentOverridesBulkAction, {
    onSuccess: () => {
      setSel(new Set());
      setBulkValue('');
    },
  });

  useEffect(() => {
    const up = () => (drag.current = null);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  // nova stranica ili filtar — stari odabir ne vrijedi
  useEffect(() => setSel(new Set()), [rows, year]);

  const startDrag = (row: number, m: number, e: React.MouseEvent) => {
    if (!canEdit || e.button !== 0 || edit) return;
    const base = e.shiftKey || e.ctrlKey || e.metaKey ? new Set(sel) : new Set<string>();
    drag.current = { row, m, base };
    const next = new Set(base);
    next.add(key(rows[row].itemId, m));
    setSel(next);
  };
  const overDrag = (row: number, m: number) => {
    const d = drag.current;
    if (!d) return;
    const next = new Set(d.base);
    for (let i = Math.min(d.row, row); i <= Math.max(d.row, row); i++) {
      for (let j = Math.min(d.m, m); j <= Math.max(d.m, m); j++) next.add(key(rows[i].itemId, j));
    }
    setSel(next);
  };
  const applyBulk = (clear: boolean) => {
    const cells = [...sel].map((k) => {
      const [itemId, m] = k.split(':');
      return { itemId, month: Number(m) + 1 };
    });
    if (!cells.length) return;
    if (!clear && !bulkValue.trim()) return;
    bulk.run({ year, cells, amount: clear ? null : parseNumber(bulkValue) });
  };
  const hl = (m: number) => m === currentMonth && 'bg-info-soft';
  const future = (m: number) => currentMonth >= 0 && m > currentMonth;

  const commit = () => {
    if (!edit) return;
    const v = edit.value.trim();
    save.run({ itemId: edit.itemId, year, month: edit.m + 1, amount: v === '' ? null : parseNumber(v) });
  };

  return (
    <>
      {canEdit && sel.size > 0 && (
        <div className="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-brand-soft px-3 py-2 text-sm">
          <span className="font-medium">Označeno polja: {integer(sel.size)}</span>
          <input
            aria-label="Iznos za označena polja"
            inputMode="decimal"
            placeholder="iznos €"
            value={bulkValue}
            onChange={(e) => setBulkValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyBulk(false)}
            className="h-7 w-24 rounded border border-line bg-panel px-2 text-right text-sm focus:border-brand focus:outline-none"
          />
          <Button size="sm" variant="primary" icon={<PenLine className="size-3.5" />} loading={bulk.pending} disabled={!bulkValue.trim()} onClick={() => applyBulk(false)}>
            Upiši
          </Button>
          <Button size="sm" icon={<Eraser className="size-3.5" />} loading={bulk.pending} onClick={() => applyBulk(true)} title="Briše ručne upise — vrijedi izračun s ugovora">
            Auto
          </Button>
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => setSel(new Set())}>
            Odznači
          </Button>
        </div>
      )}
      <div className="overflow-x-auto scroll-slim rounded-lg bg-panel shadow-[var(--shadow-panel)]" onMouseLeave={() => (drag.current = null)}>
        <table className="data-table no-stack compact [&_td]:whitespace-nowrap">
          <thead>
            <tr>
              <th className="sticky left-0 z-[2] w-40 min-w-40 max-w-40 bg-panel-2 max-sm:w-28 max-sm:min-w-28 max-sm:max-w-28">Klijent</th>
              <th className="sticky left-40 z-[2] bg-panel-2 max-sm:static">Serijski</th>
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
            {rows.map((r, ri) => (
              <tr key={r.itemId}>
                <td className="sticky left-0 z-[1] w-40 min-w-40 max-w-40 truncate bg-panel max-sm:w-28 max-sm:min-w-28 max-sm:max-w-28 max-sm:shadow-[1px_0_0_var(--color-line)]" title={r.partner ?? ''}>
                  {r.partner ?? <span className="text-fg-4">—</span>}
                </td>
                <td className="sticky left-40 z-[1] bg-panel max-sm:static">
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
                  const on = sel.has(key(r.itemId, m));
                  return (
                    <td
                      key={m}
                      className={cn(
                        'num select-none',
                        hl(m),
                        future(m) && !c.manual && 'bg-panel-2/60',
                        c.manual && 'font-bold',
                        canEdit && 'cursor-cell',
                        on && 'bg-brand-soft outline outline-1 -outline-offset-1 outline-brand/50',
                      )}
                      onMouseDown={(e) => startDrag(ri, m, e)}
                      onMouseEnter={() => overDrag(ri, m)}
                      title={c.manual ? 'Ručni upis — dvoklik (dodir) za izmjenu, prazno vraća izračun' : canEdit ? 'Dvoklik (dodir) za ručni upis' : undefined}
                      onDoubleClick={() => canEdit && setEdit({ itemId: r.itemId, m, value: c.manual && c.v !== null ? String(c.v).replace('.', ',') : '' })}
                      // na dodirnom zaslonu dvoklik ne radi pouzdano — dovoljan je jedan dodir
                      onClick={() => canEdit && !editing && window.matchMedia('(pointer: coarse)').matches && setEdit({ itemId: r.itemId, m, value: c.manual && c.v !== null ? String(c.v).replace('.', ',') : '' })}
                    >
                      {editing ? (
                        <input
                          autoFocus
                          aria-label="Ručni iznos"
                          inputMode="decimal"
                          enterKeyHint="done"
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
              <td className="sticky left-0 z-[1] max-sm:static" colSpan={2}>
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
      {canEdit && <p className="mt-2 text-xs text-fg-3 max-sm:hidden">Povucite mišem preko polja za skupni unos (Shift dodaje) · dvoklik za izmjenu jednog polja.</p>}
    </>
  );
}
