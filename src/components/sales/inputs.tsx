'use client';

import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { controlClass } from '@/components/ui/field';
import { parseNumber } from '@/domain/money';

const fmt = new Intl.NumberFormat('hr-HR', { maximumFractionDigits: 6, useGrouping: false });

/**
 * Brojčano polje koje prihvaća zarez i točku („12,5", „1.500,00"); dok se
 * tipka, zadržava upisani tekst, a van šalje broj.
 */
export function NumberInput({
  value,
  onValue,
  className,
  nullable,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: number | null;
  onValue: (v: number | null) => void;
  nullable?: boolean;
}) {
  const show = (v: number | null) => (v === null ? '' : fmt.format(v));
  const [text, setText] = useState(show(value));
  useEffect(() => {
    // vanjska promjena (npr. nova cijena) — prepiši tekst samo ako se razlikuje
    const cur = text.trim() === '' ? null : parseNumber(text);
    if (cur !== value) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  // roditelj je upisani broj ograničio (npr. na najviše dopušteno) a vrijednost je ostala ista kao prije —
  // efekt gore se ne okida, pa se tekst prepisuje ovdje (nakon svakog upisa)
  const sent = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const s = sent.current;
    sent.current = undefined;
    if (s !== undefined && s !== null && Number.isFinite(s) && s !== value) setText(show(value));
  });
  return (
    <input
      {...rest}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.trim();
        const n = t === '' ? (nullable ? null : 0) : parseNumber(t);
        if (t !== '') sent.current = n;
        onValue(n);
      }}
      onBlur={(e) => {
        // napuštanjem polja tekst uvijek pokazuje stvarnu (primijenjenu) vrijednost
        const cur = text.trim() === '' ? null : parseNumber(text);
        if (cur !== value) setText(show(value));
        rest.onBlur?.(e);
      }}
      className={cn(controlClass, 'h-8 text-right tnum', className)}
    />
  );
}

// ključ retka u editoru — u line-tools.ts (bez 'use client'), da ga mogu zvati i poslužiteljske početne vrijednosti
export { lineKey } from './line-tools';
