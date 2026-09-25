'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, FileSpreadsheet, FileText } from 'lucide-react';
import { buttonClass, type ButtonSize } from './button';
import { cn } from '@/lib/cn';

/** Dodaje `format=…` postojećoj poveznici izvoza (zadržava ostale parametre). */
export function withFormat(href: string, format: 'csv' | 'xlsx' | 'pdf') {
  const [path, qs = ''] = href.split('?');
  const sp = new URLSearchParams(qs);
  if (format === 'csv') sp.delete('format');
  else sp.set('format', format);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * Izvoz popisa: gumb „Izvoz" s izborom Excel / CSV / PDF — ista API ruta s
 * `?format=xlsx|pdf` (poslužitelj: `csvOrXlsx` iz server/xlsx.ts).
 * `pdf={false}` skriva PDF, `pdfHref` ga usmjerava na drugu poveznicu,
 * `csv={false}` skriva CSV. Obične poveznice — bez klijentske navigacije i prefetcha.
 */
export function ExportButtons({
  href,
  pdfHref,
  pdf = true,
  csv = true,
  size = 'md',
  label = 'Izvoz',
  className,
}: {
  /** API ruta izvoza s filtrima (CSV); Excel/PDF su ista ruta s `format=xlsx|pdf`. */
  href: string;
  /** Druga poveznica za PDF (zadano: ista ruta s `format=pdf`). */
  pdfHref?: string;
  /** Prikaži PDF (zadano da). */
  pdf?: boolean;
  /** Prikaži CSV (zadano da). */
  csv?: boolean;
  size?: ButtonSize;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-fg hover:bg-muted';
  return (
    <div ref={ref} className={cn('relative inline-block', className)} data-export>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu" className={buttonClass('secondary', size)}>
        <Download className="size-4" />
        {label}
        <ChevronDown className="size-3.5 text-fg-3" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 min-w-44 rounded-lg bg-panel p-1 shadow-[var(--shadow-pop)] max-sm:left-0 max-sm:right-auto">
          <a role="menuitem" href={withFormat(href, 'xlsx')} className={item} onClick={() => setOpen(false)}>
            <FileSpreadsheet className="size-4 text-ok" /> Excel (.xlsx)
          </a>
          {csv && (
            <a role="menuitem" href={withFormat(href, 'csv')} className={item} onClick={() => setOpen(false)}>
              <Download className="size-4 text-fg-3" /> CSV
            </a>
          )}
          {pdf && (
            <a role="menuitem" href={pdfHref ?? withFormat(href, 'pdf')} target="_blank" rel="noreferrer" className={item} onClick={() => setOpen(false)}>
              <FileText className="size-4 text-bad" /> PDF
            </a>
          )}
        </div>
      )}
    </div>
  );
}
