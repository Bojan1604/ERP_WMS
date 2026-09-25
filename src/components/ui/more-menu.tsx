'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { buttonClass } from './button';

/**
 * Sporedne radnje u zaglavlju stranice. Na računalu (sm+) stoje u retku kao i
 * ostali gumbi; na mobitelu su iza gumba „Više" u padajućem popisu.
 * Sadržaj ostaje montiran i kad je popis zatvoren (dijalozi potvrde žive u njemu).
 */
export function MoreMenu({ children, label = 'Više' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  // popis se poravnava s onim rubom gumba koji je bliže sredini zaslona — inače izlazi izvan ekrana
  const [alignRight, setAlignRight] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative sm:contents">
      <button
        type="button"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAlignRight(r.left + r.width / 2 > window.innerWidth / 2);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className={buttonClass('secondary', 'md', 'sm:hidden')}
      >
        <MoreHorizontal className="size-4" />
        {label}
      </button>
      <div
        className={cn(
          'sm:contents',
          open && (alignRight ? 'max-sm:right-0' : 'max-sm:left-0'),
          open
            ? 'max-sm:absolute max-sm:top-full max-sm:max-w-[calc(100vw-2rem)] max-sm:z-40 max-sm:mt-1 max-sm:flex max-sm:min-w-52 max-sm:flex-col max-sm:gap-1.5 max-sm:rounded-lg max-sm:bg-panel max-sm:p-2 max-sm:shadow-[var(--shadow-pop)] max-sm:[&>button]:w-full max-sm:[&>button]:justify-start max-sm:[&>a]:w-full max-sm:[&>a]:justify-start'
            : 'max-sm:hidden',
        )}
      >
        {children}
      </div>
    </div>
  );
}
