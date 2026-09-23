'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { controlClass } from './field';

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Padajući odabir s pretraživanjem. Za velike popise (uređaji) koristite
 * `onSearch` — tada se opcije dohvaćaju s poslužitelja dok korisnik tipka.
 * `name` dodaje skriveno polje za obrasce.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Odaberite…',
  name,
  onSearch,
  disabled,
  className,
  allowEmpty,
}: {
  options: ComboOption[];
  value: string | null;
  onChange?: (value: string | null, option?: ComboOption) => void;
  placeholder?: string;
  name?: string;
  onSearch?: (q: string) => Promise<ComboOption[]>;
  disabled?: boolean;
  className?: string;
  allowEmpty?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<ComboOption[] | null>(null);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<ComboOption | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onSearch || !open) return;
    const t = setTimeout(() => onSearch(q).then(setRemote), 200);
    return () => clearTimeout(t);
  }, [q, open, onSearch]);

  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const list = useMemo(() => {
    if (onSearch) return remote ?? options;
    const t = q.trim().toLowerCase();
    const src = t ? options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(t)) : options;
    return src.slice(0, 200);
  }, [q, options, remote, onSearch]);

  const current = options.find((o) => o.value === value) ?? (picked?.value === value ? picked : null);
  const choose = (o: ComboOption | null) => {
    setPicked(o);
    onChange?.(o?.value ?? null, o ?? undefined);
    setOpen(false);
    setQ('');
  };

  return (
    <div ref={box} className={cn('relative', className)}>
      {name && <input type="hidden" name={name} value={value ?? ''} />}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(controlClass, 'flex h-8 items-center justify-between gap-2 text-left')}
      >
        <span className={cn('truncate', !current && 'text-fg-4')}>{current?.label ?? placeholder}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fg-3" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-64 overflow-hidden rounded-lg bg-panel shadow-[var(--shadow-pop)]">
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, list.length - 1));
              else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
              else if (e.key === 'Enter') {
                e.preventDefault();
                if (list[active]) choose(list[active]);
              } else if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Traži…"
            className="h-9 w-full border-b border-line bg-panel px-3 text-base focus:outline-none"
          />
          <ul className="max-h-72 overflow-y-auto scroll-slim py-1">
            {allowEmpty && (
              <li>
                <button type="button" onClick={() => choose(null)} className="w-full px-3 py-1.5 text-left text-fg-3 hover:bg-muted">
                  — bez odabira —
                </button>
              </li>
            )}
            {list.map((o, i) => (
              <li key={o.value}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o)}
                  className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left', i === active && 'bg-muted')}
                >
                  <Check className={cn('size-3.5 shrink-0', o.value === value ? 'text-brand' : 'opacity-0')} />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint && <span className="shrink-0 text-xs text-fg-3">{o.hint}</span>}
                </button>
              </li>
            ))}
            {!list.length && <li className="px-3 py-2 text-sm text-fg-3">Nema rezultata.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
