'use client';

import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { controlClass } from './field';
import { comboReducer, filterOptions, initialComboState, type ComboItem } from './combobox-state';
import { Popover, focusAfter } from './popover';

export type ComboOption = ComboItem;

/** Okidač padajućih odabira: iste visine kao ostala polja (na mobitelu 40 px kao input/select). */
export const comboTriggerClass = 'flex h-8 items-center gap-2 text-left max-sm:h-10';

/**
 * Padajući odabir s pretraživanjem. Za velike popise (uređaji, partneri) koristite
 * `onSearch` — tada se opcije dohvaćaju s poslužitelja dok korisnik tipka (bez dijakritika).
 * `name` dodaje skriveno polje za obrasce.
 *
 * Tipkovnica: strelica dolje/gore, Enter ili razmak otvaraju; strelice biraju; Enter odabire (dok se
 * rezultat za upisani upit još učitava, čeka ga — nikad ne bira zastarjeli); Esc zatvara samo
 * popis (ne i dijalog oko njega) i vraća fokus na okidač; Tab zatvara popis i ide na sljedeće polje.
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
  id,
  'aria-label': ariaLabel,
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
  id?: string;
  'aria-label'?: string;
}) {
  const [st, dispatch] = useReducer(comboReducer<ComboOption>, undefined, initialComboState<ComboOption>);
  const [picked, setPicked] = useState<ComboOption | null>(null);
  // combobox nema ime iz sadržaja — bez <label> oko polja (filtri) ime je placeholder
  const [autoLabel, setAutoLabel] = useState<string | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-o${i}`;
  const remote = !!onSearch;

  // pretraga na poslužitelju: odgovor nosi redni broj upita, reducer odbacuje zastarjele
  useEffect(() => {
    if (!onSearch || !st.open) return;
    const { seq, q } = st;
    let live = true;
    const t = setTimeout(
      () =>
        onSearch(q).then(
          (options) => live && dispatch({ type: 'results', seq, options }),
          () => live && dispatch({ type: 'results', seq, options: [] }),
        ),
      q ? 200 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.seq, st.open, onSearch]);

  // odabir (i odgođeni — Enter dok se čekao rezultat) predaje se van
  useEffect(() => {
    if (!st.selection) return;
    const o = st.selection.option;
    setPicked(o);
    onChange?.(o?.value ?? null, o ?? undefined);
    btn.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.selection]);

  useEffect(() => {
    if (!st.open) return;
    const close = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || panel.current?.contains(t)) return;
      dispatch({ type: 'close' });
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [st.open]);

  const list = remote ? (st.remote ?? (st.q ? [] : options)) : filterOptions(options, st.q);

  useEffect(() => {
    if (st.open) document.getElementById(optId(st.active))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.active, st.open]);

  useEffect(() => {
    if (!ariaLabel && btn.current && !btn.current.labels?.length && !btn.current.getAttribute('aria-labelledby')) setAutoLabel(placeholder);
  }, [ariaLabel, placeholder]);

  const current = options.find((o) => o.value === value) ?? (picked?.value === value ? picked : null);

  const closeToTrigger = () => {
    dispatch({ type: 'close' });
    btn.current?.focus();
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      dispatch({ type: 'move', delta: e.key === 'ArrowDown' ? 1 : -1, count: list.length });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      dispatch({ type: 'enter', list });
    } else if (e.key === 'Escape') {
      // samo popis — Esc ne smije zatvoriti <dialog> oko polja (i izgubiti unos)
      e.preventDefault();
      e.stopPropagation();
      closeToTrigger();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      dispatch({ type: 'close' });
      if (btn.current) focusAfter(btn.current, e.shiftKey);
    }
  };

  return (
    <div ref={box} className={cn('relative', className)}>
      {name && <input type="hidden" name={name} value={value ?? ''} />}
      <button
        ref={btn}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={st.open}
        aria-controls={st.open ? listId : undefined}
        aria-label={ariaLabel ?? autoLabel}
        disabled={disabled}
        onClick={() => dispatch(st.open ? { type: 'close' } : { type: 'open', remote })}
        onKeyDown={(e) => {
          if (!st.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            dispatch({ type: 'open', remote });
          } else if (st.open && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeToTrigger();
          }
        }}
        className={cn(controlClass, comboTriggerClass, 'justify-between')}
      >
        <span className={cn('truncate', !current && 'text-fg-3')}>{current?.label ?? placeholder}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fg-3" />
      </button>
      <Popover anchor={btn} open={st.open} panelRef={panel}>
        <div className="relative shrink-0">
          <input
            autoFocus
            value={st.q}
            onChange={(e) => dispatch({ type: 'query', q: e.target.value, remote })}
            onKeyDown={onInputKey}
            placeholder="Traži…"
            aria-label="Traži"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={list.length ? optId(st.active) : undefined}
            aria-busy={st.loading}
            autoComplete="off"
            className="h-9 w-full border-b border-line bg-panel px-3 pr-8 text-base placeholder:text-fg-3 focus:outline-none max-sm:h-11"
          />
          {st.loading && <Loader2 className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-fg-3" aria-hidden />}
        </div>
        <ul id={listId} role="listbox" className={cn('min-h-0 flex-1 overflow-y-auto scroll-slim py-1', st.loading && st.remote && 'opacity-60')}>
          {allowEmpty && (
            <li
              role="option"
              aria-selected={!value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => dispatch({ type: 'pick', option: null })}
              className="cursor-pointer px-3 py-1.5 text-fg-3 hover:bg-muted max-sm:py-2.5"
            >
              — bez odabira —
            </li>
          )}
          {list.map((o, i) => (
            <li
              key={o.value}
              id={optId(i)}
              role="option"
              aria-selected={o.value === value}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => dispatch({ type: 'hover', index: i })}
              onClick={() => dispatch({ type: 'pick', option: o })}
              className={cn('flex cursor-pointer items-center gap-2 px-3 py-1.5 max-sm:py-2.5', i === st.active && 'bg-muted')}
            >
              <Check className={cn('size-3.5 shrink-0', o.value === value ? 'text-brand' : 'opacity-0')} />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-fg-3">{o.hint}</span>}
            </li>
          ))}
          {!list.length && <li className="px-3 py-2 text-sm text-fg-3">{st.loading ? 'Traženje…' : 'Nema rezultata.'}</li>}
        </ul>
      </Popover>
    </div>
  );
}
