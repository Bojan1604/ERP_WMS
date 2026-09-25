'use client';

import { Children, isValidElement, useEffect, useId, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Check, ChevronDown, Loader2, Search, SlidersHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { controlClass, type Option } from './field';
import { joinMulti, splitMulti } from '@/lib/list-params';
import { fold } from '@/lib/fold';
import { Popover, focusAfter } from './popover';

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
  const [remote, setRemote] = useState<{ q: string; items: Option[] } | null>(null);
  const [active, setActive] = useState(0);
  const known = useRef(new Map<string, string>());
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-o${i}`;
  // zarez unutar vrijednosti (CPU „ARM Cortex-A53, 4 jezgre") je „escapean" — list-params joinMulti/splitMulti
  const selected = splitMulti(params.get(name) ?? '').map((v) => v.trim()).filter(Boolean);
  const chosen = new Set(selected);
  for (const o of [...options, ...(remote?.items ?? [])]) known.current.set(o.value, o.label);

  useEffect(() => {
    if (!onSearch || !open) return;
    // zastarjeli odgovor (upit se u međuvremenu promijenio) se odbacuje
    let live = true;
    const t = setTimeout(() => onSearch(q).then((items) => live && setRemote({ q, items })), q ? 200 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, open, onSearch]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || panel.current?.contains(t)) return;
      closeList();
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  function closeList() {
    setOpen(false);
    setQ('');
    setRemote(null);
    setActive(0);
  }

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
  const t = fold(q.trim());
  const list = onSearch
    ? [
        // odabrani prvi (i kad nisu među rezultatima pretrage), zatim rezultati
        ...(t ? [] : selected.map((v) => ({ value: v, label: known.current.get(v) ?? v }))),
        ...(remote?.items ?? []).filter((o) => t || !chosen.has(o.value)),
      ]
    : t
      ? options.filter((o) => fold(o.label).includes(t))
      : options;
  const loading = !!onSearch && remote?.q !== q;
  const summary =
    selected.length === 0
      ? label
      : selected.length === 1
        ? `${label}: ${known.current.get(selected[0]) ?? selected[0]}`
        : `${label} (${selected.length})`;

  useEffect(() => {
    if (open) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  // tipkovnica (na okidaču i u polju za pretragu): strelice, Enter/razmak uključuje/isključuje, Esc/Tab zatvaraju
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    const inInput = e.target instanceof HTMLInputElement;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(a + (e.key === 'ArrowDown' ? 1 : -1), list.length - 1)));
    } else if (e.key === 'Enter' || (e.key === ' ' && !inInput)) {
      e.preventDefault();
      // rezultat za upisani upit još nije stigao — ne diraj zastarjeli popis
      if (loading) return;
      if (list[active]) toggle(list[active].value);
    } else if (e.key === 'Escape') {
      // samo popis — ne i dijalog oko filtra
      e.preventDefault();
      e.stopPropagation();
      closeList();
      btn.current?.focus();
    } else if (e.key === 'Tab' && inInput) {
      e.preventDefault();
      closeList();
      if (btn.current) focusAfter(btn.current, e.shiftKey);
    } else if (e.key === 'Tab') closeList();
  };

  return (
    <div ref={box} className={cn('relative', className)} onKeyDown={onKey}>
      <button
        ref={btn}
        type="button"
        onClick={() => (open ? closeList() : setOpen(true))}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={summary}
        aria-activedescendant={open && !withSearch && list.length ? optId(active) : undefined}
        className={cn(controlClass, 'flex h-8 w-auto max-w-64 items-center gap-1.5 pr-2 text-left max-sm:h-10', selected.length > 0 && 'border-brand text-brand')}
      >
        <span className="truncate">{summary}</span>
        {pending ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <ChevronDown className="size-3.5 shrink-0 text-fg-3" />}
      </button>
      <Popover anchor={btn} open={open} panelRef={panel}>
        {withSearch && (
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            placeholder="Traži…"
            aria-label="Traži"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={list.length ? optId(active) : undefined}
            autoComplete="off"
            className="h-9 w-full shrink-0 border-b border-line bg-panel px-3 text-base placeholder:text-fg-3 focus:outline-none max-sm:h-11"
          />
        )}
        <ul id={listId} className={cn('min-h-0 flex-1 overflow-y-auto scroll-slim py-1', loading && remote && 'opacity-60')} role="listbox" aria-multiselectable aria-busy={loading}>
          {list.map((o, i) => {
            const on = chosen.has(o.value);
            return (
              <li
                key={o.value}
                id={optId(i)}
                role="option"
                aria-selected={on}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => toggle(o.value)}
                className={cn('flex cursor-pointer items-center gap-2 px-3 py-1.5 max-sm:py-2.5', i === active && 'bg-muted')}
              >
                <span className={cn('flex size-4 shrink-0 items-center justify-center rounded border', on ? 'border-brand bg-brand text-white' : 'border-line-strong')}>
                  {on && <Check className="size-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
              </li>
            );
          })}
          {!list.length && <li className="px-3 py-2 text-sm text-fg-3">{loading ? 'Traženje…' : 'Nema rezultata.'}</li>}
        </ul>
        {selected.length > 0 && (
          <div className="shrink-0 border-t border-line px-3 py-1.5">
            <button type="button" onClick={() => apply(new Set())} className="text-sm text-brand hover:underline">
              Očisti odabir
            </button>
          </div>
        )}
      </Popover>
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
