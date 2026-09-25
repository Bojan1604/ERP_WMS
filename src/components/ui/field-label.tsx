'use client';

import type { MouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Oznaka polja: `<label>` oko teksta i kontrole (klik na tekst fokusira polje, `getByLabel` radi).
 * Složene kontrole (Combobox, pickeri) imaju vlastite gumbe; klik na opciju u njihovom popisu
 * NE smije aktivirati oznaku — preglednik bi inače „kliknuo" prvi gumb unutar oznake (gumb
 * padajućeg izbornika) i izbornik bi se ponovno otvorio. Zato se aktivacija oznake poništava
 * za klik na bilo koji `button[type=button]` unutar nje (takav gumb nema zadanu radnju).
 */
export function Field({
  label,
  children,
  hint,
  error,
  required,
  className,
}: {
  label?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={cn('block min-w-0', className)} onClick={stopLabelActivation}>
      {label && (
        <span className="mb-1 block text-sm font-medium text-fg-2">
          {label}
          {required && <span className="text-bad-strong"> *</span>}
        </span>
      )}
      {children}
      {error ? <span className="mt-1 block text-xs text-bad-strong">{error}</span> : hint ? <span className="mt-1 block text-xs text-fg-3">{hint}</span> : null}
    </label>
  );
}

export function stopLabelActivation(e: MouseEvent<HTMLLabelElement>) {
  const t = e.target as Element | null;
  const b = t?.closest?.('button[type="button"], [role="option"]');
  if (b && e.currentTarget.contains(b)) e.preventDefault();
}
