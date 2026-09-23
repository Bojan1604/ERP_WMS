'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { controlClass, type Option } from './field';

/**
 * Filtri žive u URL-u (?q=…&status=…), pa su poveznice djeljive, „natrag"
 * radi, a poslužitelj filtrira i straniči u bazi. Promjena filtra vraća na
 * prvu stranicu.
 */
export function useQueryParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const set = (patch: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    const qs = next.toString();
    start(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };
  return { params, set, pending };
}

export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('no-print mb-3 flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

export function SearchFilter({ name = 'q', placeholder = 'Traži…', className }: { name?: string; placeholder?: string; className?: string }) {
  const { params, set, pending } = useQueryParams();
  const [value, setValue] = useState(params.get(name) ?? '');
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => set({ [name]: value.trim() || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className={cn('relative w-full sm:w-72', className)}>
      {pending ? (
        <Loader2 className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-fg-3" />
      ) : (
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
      )}
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className={cn(controlClass, 'h-8 pl-8 pr-7')}
        autoComplete="off"
      />
      {value && (
        <button type="button" onClick={() => setValue('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg" aria-label="Očisti">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function SelectFilter({ name, options, placeholder, className }: { name: string; options: Option[]; placeholder: string; className?: string }) {
  const { params, set } = useQueryParams();
  return (
    <select value={params.get(name) ?? ''} onChange={(e) => set({ [name]: e.target.value || null })} className={cn(controlClass, 'h-8 w-auto max-w-56 pr-7', className)}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function DateFilter({ name, label }: { name: string; label: string }) {
  const { params, set } = useQueryParams();
  return (
    <label className="flex items-center gap-1.5 text-sm text-fg-3">
      {label}
      <input type="date" value={params.get(name) ?? ''} onChange={(e) => set({ [name]: e.target.value || null })} className={cn(controlClass, 'h-8 w-36')} />
    </label>
  );
}

export function ToggleFilter({ name, label }: { name: string; label: string }) {
  const { params, set } = useQueryParams();
  const on = params.get(name) === '1';
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-fg-2">
      <input type="checkbox" checked={on} onChange={() => set({ [name]: on ? null : '1' })} className="size-4 accent-[var(--color-brand)]" />
      {label}
    </label>
  );
}

/** Segmentirani odabir (npr. stanje naplate). */
export function SegmentFilter({ name, options }: { name: string; options: Option[] }) {
  const { params, set } = useQueryParams();
  const cur = params.get(name) ?? '';
  return (
    <div className="inline-flex rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => set({ [name]: o.value || null })}
          className={cn('h-7 rounded px-2.5 text-sm', cur === o.value ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-3 hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
