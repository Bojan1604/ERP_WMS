'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Višestruki odabir redaka u tablici koju iscrtava poslužitelj: tablica ostaje
 * server komponenta, a samo kvačice i traka radnji su klijentske.
 * Shift+klik označava raspon.
 */
interface Sel {
  ids: string[];
  selected: Set<string>;
  toggle: (id: string, shift?: boolean) => void;
  setAll: (on: boolean) => void;
  clear: () => void;
}
const Ctx = createContext<Sel | null>(null);

export function SelectionProvider({ ids, children }: { ids: string[]; children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [last, setLast] = useState<string | null>(null);
  const value = useMemo<Sel>(
    () => ({
      ids,
      selected,
      toggle: (id, shift) => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (shift && last) {
            const a = ids.indexOf(last);
            const b = ids.indexOf(id);
            const on = !prev.has(id);
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) on ? next.add(ids[i]) : next.delete(ids[i]);
          } else if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setLast(id);
      },
      setAll: (on) => setSelected(on ? new Set(ids) : new Set()),
      clear: () => setSelected(new Set()),
    }),
    [ids, selected, last],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSelection() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSelection izvan SelectionProvider');
  return c;
}

export function SelectAll() {
  const { ids, selected, setAll } = useSelection();
  const all = ids.length > 0 && selected.size === ids.length;
  return (
    <input
      type="checkbox"
      aria-label="Označi sve"
      checked={all}
      ref={(el) => {
        if (el) el.indeterminate = selected.size > 0 && !all;
      }}
      onChange={() => setAll(!all)}
      className="size-4 align-middle accent-[var(--color-brand)]"
    />
  );
}

export function SelectRow({ id }: { id: string }) {
  const { selected, toggle } = useSelection();
  return (
    <input
      type="checkbox"
      aria-label="Označi"
      checked={selected.has(id)}
      onClick={(e) => {
        e.stopPropagation();
        toggle(id, e.shiftKey);
      }}
      onChange={() => {}}
      className="size-4 align-middle accent-[var(--color-brand)]"
    />
  );
}

/** Red tablice koji zna je li označen (za pozadinu). */
export function SelectableTr({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const { selected } = useSelection();
  return (
    <tr data-selected={selected.has(id)} className={className}>
      {children}
    </tr>
  );
}

/** Traka radnji za označene retke; prikazuje se tek kad je nešto označeno. */
export function SelectionBar({ children }: { children: (ids: string[], clear: () => void) => ReactNode }) {
  const { selected, clear } = useSelection();
  if (!selected.size) return null;
  return (
    <div className={cn('no-print sticky top-0 z-20 mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-nav px-3 py-2 text-nav-fg shadow-[var(--shadow-pop)]')}>
      <span className="mr-1 text-sm">
        Označeno: <b className="text-white">{selected.size}</b>
      </span>
      {children([...selected], clear)}
      <button type="button" onClick={clear} className="ml-auto text-sm text-nav-fg-2 hover:text-white">
        Poništi odabir
      </button>
    </div>
  );
}
