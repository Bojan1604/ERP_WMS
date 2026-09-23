'use client';

import Link from 'next/link';
import { Check, ChevronRight, ScanLine } from 'lucide-react';
import { Badge, COLOR_TONE } from '@/components/ui/misc';
import { useSelection } from '@/components/ui/selection';
import { cn } from '@/lib/cn';

export interface ItemCardRow {
  id: string;
  serial: string;
  dupNote: string | null;
  model: string;
  status: { name: string; color: string };
  warehouse: string | null;
  partner: string | null;
}

/**
 * Popis uređaja na mobitelu: kartice s velikim serijskim brojem i velikom
 * kvačicom (dodir kartice = označi), strelica otvara karticu uređaja.
 */
export function ItemCards({ rows, selectable }: { rows: ItemCardRow[]; selectable: boolean }) {
  const { selected, toggle, ids, setAll } = useSelection();
  const all = ids.length > 0 && selected.size === ids.length;
  return (
    <div className={cn('sm:hidden', selected.size > 0 && 'pb-20')} data-item-cards>
      {selectable && rows.length > 0 && (
        <button type="button" onClick={() => setAll(!all)} className="mb-2 flex h-10 items-center gap-2 px-1 text-base text-fg-2">
          <Box on={all} />
          {all ? 'Odznači sve' : `Označi sve na stranici (${rows.length})`}
        </button>
      )}
      <ul className="space-y-2">
        {rows.map((r) => {
          const on = selected.has(r.id);
          return (
            <li
              key={r.id}
              data-item-card={r.serial}
              className={cn('flex items-stretch overflow-hidden rounded-lg bg-panel shadow-[var(--shadow-panel)] transition-colors', on && 'bg-brand-soft ring-2 ring-brand')}
            >
              <button
                type="button"
                disabled={!selectable}
                onClick={() => toggle(r.id)}
                aria-pressed={on}
                aria-label={`Označi ${r.serial}`}
                className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-3 text-left disabled:cursor-default"
              >
                {selectable && <Box on={on} />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-md font-semibold">
                    {r.serial}
                    {r.dupNote && <span className="ml-1 text-xs font-normal text-warn">({r.dupNote})</span>}
                  </span>
                  <span className="block truncate text-sm text-fg-2">{r.model}</span>
                  <span className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-fg-3">
                    <Badge tone={COLOR_TONE[r.status.color] ?? 'neutral'}>{r.status.name}</Badge>
                    <span className="truncate">{r.partner ?? r.warehouse ?? ''}</span>
                  </span>
                </span>
              </button>
              <Link prefetch={false} href={`/skladiste/${r.id}`} className="grid w-12 shrink-0 place-items-center text-fg-3 active:bg-muted" aria-label={`Otvori ${r.serial}`}>
                <ChevronRight className="size-5" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Box({ on }: { on: boolean }) {
  return (
    <span className={cn('grid size-7 shrink-0 place-items-center rounded-md border-2', on ? 'border-brand bg-brand text-white' : 'border-line-strong bg-panel')}>
      {on && <Check className="size-4" strokeWidth={3} />}
    </span>
  );
}

/** Plutajući gumb „Skeniraj" na mobitelu — otvara skeniranje u serijskom načinu (skupna radnja). */
export function ScanFab() {
  const { selected } = useSelection();
  if (selected.size) return null; // tada je pri dnu traka radnji
  return (
    <Link
      prefetch={false}
      href="/skladiste/skeniranje?nacin=serijski"
      className="no-print fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-12 items-center gap-2 rounded-full bg-brand px-5 font-medium text-white shadow-[var(--shadow-pop)] sm:hidden"
    >
      <ScanLine className="size-5" />
      Skeniraj
    </Link>
  );
}
