'use client';

import { Children, isValidElement, useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Check, ChevronDown, Loader2, Search, SlidersHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { controlClass, type Option } from './field';
import { joinMulti, splitMulti } from '@/lib/list-params';

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

/**
 * Traka filtara. Na mobitelu ostaje vidljiv samo prvi element (obično tražilica),
 * a ostali su iza gumba „Filtri" (s brojem aktivnih filtara).
 */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const params = useSearchParams();
  // tražilica i segmentni odabir ostaju vidljivi; ostalo je na mobitelu iza gumba „Filtri"
  const items = Children.toArray(children).filter(Boolean);
  const pinnedTypes: unknown[] = [SearchFilter, SegmentFilter];
  // iz poslužiteljske komponente klijentski filtri stižu kao „lazy" reference, pa usporedba
  // tipa ne uspijeva — tada ih prepoznajemo po propsima (SearchFilter: name/placeholder/className, SegmentFilter: name + options)
  const only = (p: object, keys: string[]) => Object.keys(p).every((k) => keys.includes(k));
  const isPinned = (c: unknown) => {
    if (!isValidElement(c)) return false;
    if (pinnedTypes.includes(c.type)) return true;
    if (typeof c.type === 'string') return false;
    const p = (c.props ?? {}) as Record<string, unknown>;
    const search = only(p, ['name', 'placeholder', 'className']);
    const segment = only(p, ['name', 'options']) && Array.isArray(p.options);
    return search || segment;
  };
  const pinnedSet = new Set(items.filter(isPinned));
  if (!pinnedSet.size && items.length) pinnedSet.add(items[0]);
  const restCount = items.length - pinnedSet.size;
  const active = [...params.keys()].filter((k) => !['page', 'q', 'sort', 'dir', 'tab', 'format'].includes(k)).length;
  // redoslijed na računalu ostaje kao u kodu; na mobitelu (order) prvo stoje stalni filtri, pa gumb, pa ostali
  return (
    <div className={cn('no-print mb-3 flex flex-wrap items-center gap-2', className)}>
      {items.map((c, i) =>
        pinnedSet.has(c) ? (
          c
        ) : (
          <div key={isValidElement(c) && c.key != null ? c.key : i} className={cn('max-sm:order-2 max-sm:w-full sm:contents', open ? 'max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-2' : 'max-sm:hidden')}>
            {c}
          </div>
        ),
      )}
      {restCount > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(controlClass, 'order-1 flex h-10 w-auto items-center gap-1.5 sm:hidden', active > 0 && 'border-brand text-brand')}
        >
          <SlidersHorizontal className="size-4" />
          Filtri{active > 0 && ` (${active})`}
        </button>
      )}
    </div>
  );
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

/** `fallback` = zadani datum koji poslužitelj primjenjuje kad ga u URL-u nema (prikazuje se bez preusmjeravanja). */
export function DateFilter({ name, label, fallback }: { name: string; label: string; fallback?: string }) {
  const { params, set } = useQueryParams();
  return (
    <label className="flex items-center gap-1.5 text-sm text-fg-3">
      {label}
      <input type="date" value={params.get(name) ?? fallback ?? ''} onChange={(e) => set({ [name]: e.target.value || null })} className={cn(controlClass, 'h-8 w-36')} />
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

/**
 * Višestruki odabir u jednom parametru URL-a (`?status=a,b,c`). Poslužitelj ga
 * čita s `parseMulti(sp, name, dopušteno)` iz `@/lib/list-params`. U `FilterBar`
 * na mobitelu je iza gumba „Filtri" (kao SelectFilter).
 */
export function MultiSelectFilter({
  name,
  label,
  options,
  className,
  searchable,
  onSearch,
}: {
  name: string;
  /** Naziv filtra na gumbu (npr. „Partner"). */
  label: string;
  /** Sve opcije — ili, uz `onSearch`, samo trenutno odabrane (razriješene na poslužitelju). */
  options: Option[];
  className?: string;
  /** Polje za pretragu opcija; zadano kad ih je više od 8. */
  searchable?: boolean;
  /** Velik popis (partneri): opcije se traže na poslužitelju dok korisnik tipka. */
  onSearch?: (q: string) => Promise<Option[]>;
}) {
  const { params, set, pending } = useQueryParams();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<Option[] | null>(null);
  const known = useRef(new Map<string, string>());
  const box = useRef<HTMLDivElement>(null);
  // zarez unutar vrijednosti (CPU „ARM Cortex-A53, 4 jezgre") je „escapean" — list-params joinMulti/splitMulti
  const selected = splitMulti(params.get(name) ?? '').map((v) => v.trim()).filter(Boolean);
  const chosen = new Set(selected);
  for (const o of [...options, ...(remote ?? [])]) known.current.set(o.value, o.label);

  useEffect(() => {
    if (!onSearch || !open) return;
    let live = true;
    const t = setTimeout(() => onSearch(q).then((r) => live && setRemote(r)), 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, open, onSearch]);

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

  const apply = (next: Set<string>) => {
    // redoslijed kao u opcijama — isti odabir daje isti URL
    const ordered = onSearch ? [...next].sort() : options.map((o) => o.value).filter((v) => next.has(v));
    set({ [name]: ordered.length ? joinMulti(ordered) : null });
  };
  const toggle = (v: string) => {
    const next = new Set(chosen);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    apply(next);
  };
  const withSearch = onSearch ? true : (searchable ?? options.length > 8);
  const t = q.trim().toLowerCase();
  const list = onSearch
    ? [
        // odabrani prvi (i kad nisu među rezultatima pretrage), zatim rezultati
        ...(t ? [] : selected.map((v) => ({ value: v, label: known.current.get(v) ?? v }))),
        ...(remote ?? []).filter((o) => t || !chosen.has(o.value)),
      ]
    : t
      ? options.filter((o) => o.label.toLowerCase().includes(t))
      : options;
  const summary =
    selected.length === 0
      ? label
      : selected.length === 1
        ? `${label}: ${known.current.get(selected[0]) ?? selected[0]}`
        : `${label} (${selected.length})`;

  return (
    <div ref={box} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(controlClass, 'flex h-8 w-auto max-w-64 items-center gap-1.5 pr-2 text-left', selected.length > 0 && 'border-brand text-brand')}
      >
        <span className="truncate">{summary}</span>
        {pending ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <ChevronDown className="size-3.5 shrink-0 text-fg-3" />}
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 w-64 overflow-hidden rounded-lg bg-panel shadow-[var(--shadow-pop)] max-sm:w-[calc(100vw-2rem)]">
          {withSearch && (
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Traži…"
              className="h-9 w-full border-b border-line bg-panel px-3 text-base focus:outline-none"
            />
          )}
          <ul className="max-h-72 overflow-y-auto scroll-slim py-1" role="listbox" aria-multiselectable>
            {list.map((o) => {
              const on = chosen.has(o.value);
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
                  >
                    <span className={cn('flex size-4 shrink-0 items-center justify-center rounded border', on ? 'border-brand bg-brand text-white' : 'border-line-strong')}>
                      {on && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  </button>
                </li>
              );
            })}
            {!list.length && <li className="px-3 py-2 text-sm text-fg-3">Nema rezultata.</li>}
          </ul>
          {selected.length > 0 && (
            <div className="border-t border-line px-3 py-1.5">
              <button type="button" onClick={() => apply(new Set())} className="text-sm text-brand hover:underline">
                Očisti odabir
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Raspon datuma (`?od=YYYY-MM-DD&do=YYYY-MM-DD`, oba neobavezna). Poslužitelj ga
 * čita s `parseDateRange(sp)` iz `@/lib/list-params`. `label` je obavezan
 * (FilterBar po njemu razlikuje filtar od tražilice).
 */
export function DateRangeFilter({ label, from = 'od', to = 'do' }: { label: string; from?: string; to?: string }) {
  const { params, set } = useQueryParams();
  const a = params.get(from) ?? '';
  const b = params.get(to) ?? '';
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm text-fg-3">
      <span>{label}</span>
      <input type="date" aria-label={`${label} od`} value={a} max={b || undefined} onChange={(e) => set({ [from]: e.target.value || null })} className={cn(controlClass, 'h-8 w-36 max-sm:h-10 max-sm:w-44')} />
      <span>–</span>
      <input type="date" aria-label={`${label} do`} value={b} min={a || undefined} onChange={(e) => set({ [to]: e.target.value || null })} className={cn(controlClass, 'h-8 w-36 max-sm:h-10 max-sm:w-44')} />
      {(a || b) && (
        <button type="button" onClick={() => set({ [from]: null, [to]: null })} className="text-fg-3 hover:text-fg" aria-label="Očisti raspon">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
