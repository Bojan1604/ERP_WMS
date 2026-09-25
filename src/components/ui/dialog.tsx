'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Modalni prozor na izvornom <dialog> — Esc i fokus rješava preglednik. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const w = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-6xl' }[size];
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        // Esc s otvorenim padajućim popisom (Combobox/filtar, portal u dijalogu) zatvara samo popis
        if (ref.current?.querySelector('[data-popover-open]')) return;
        onClose();
      }}
      className={cn(
        'no-print m-auto w-[calc(100vw-2rem)] rounded-xl bg-panel p-0 text-fg shadow-[var(--shadow-pop)] backdrop:bg-black/40',
        // na mobitelu: list koji izlazi s dna ekrana, cijele širine
        'max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none',
        w,
      )}
    >
      {open && (
        <div className="flex max-h-[88vh] flex-col max-sm:max-h-[92dvh]">
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="text-md font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-muted" aria-label="Zatvori">
              <X className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-slim p-4">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
