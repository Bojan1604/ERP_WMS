'use client';

import { useEffect, useRef, useState } from 'react';
import { Columns3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { columnClass, visibleColumns, type ItemColumn } from '@/domain/warehouse-list';

const KEY = 'skladiste.stupci';

function load(): unknown {
  try {
    const v = localStorage.getItem(KEY);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

function save(cols: ItemColumn[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cols));
  } catch {
    /* privatni način ili blokirano spremanje — izbor vrijedi do osvježavanja */
  }
}

/**
 * Izbor vidljivih stupaca popisa uređaja. Tablica se iscrtava na poslužitelju sa
 * svim stupcima (`data-col`), a skriveni se sakrivaju stilom — izbor je zapamćen
 * u pregledniku (localStorage) i ne traži novi upit.
 */
export function ColumnChooser({ columns, canSeeCost, scope }: { columns: Array<{ key: ItemColumn; label: string }>; canSeeCost: boolean; scope: string }) {
  const [shown, setShown] = useState<Set<ItemColumn>>(() => visibleColumns(null, canSeeCost));
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShown(visibleColumns(load(), canSeeCost));
  }, [canSeeCost]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const toggle = (k: ItemColumn) => {
    const next = new Set(shown);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setShown(next);
    save(columns.map((c) => c.key).filter((c) => next.has(c)));
  };
  const reset = () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ništa */
    }
    setShown(visibleColumns(null, canSeeCost));
  };

  const hidden = columns.filter((c) => !shown.has(c.key));
  const css = hidden.map((c) => `.${scope} [data-col="${c.key}"],.${scope} .${columnClass(c.key)}{display:none}`).join('');

  return (
    <div ref={box} className="relative">
      {css && <style>{css}</style>}
      <Button size="sm" variant="subtle" icon={<Columns3 className="size-3.5" />} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Stupci
      </Button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-56 rounded-lg bg-panel py-1 shadow-[var(--shadow-pop)]">
          {columns.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted">
              <input type="checkbox" checked={shown.has(c.key)} onChange={() => toggle(c.key)} className="accent-[var(--color-brand)]" />
              {c.label}
            </label>
          ))}
          <div className="border-t border-line px-3 pt-1.5">
            <button type="button" onClick={reset} className="text-sm text-brand hover:underline">
              Zadani stupci
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
