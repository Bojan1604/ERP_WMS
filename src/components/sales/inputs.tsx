'use client';

import { useEffect, useState, type InputHTMLAttributes } from 'react';
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
  return (
    <input
      {...rest}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.trim();
        onValue(t === '' ? (nullable ? null : 0) : parseNumber(t));
      }}
      className={cn(controlClass, 'h-8 text-right tnum', className)}
    />
  );
}

// ključ retka u editoru — u line-tools.ts (bez 'use client'), da ga mogu zvati i poslužiteljske početne vrijednosti
export { lineKey } from './line-tools';
