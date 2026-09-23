'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { controlClass } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { createWedgeDetector } from './core';
import { Scanner } from './scanner';

const isEditable = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

/**
 * Ručni čitač barkodova („keyboard wedge") kad fokus nije u polju za unos:
 * brzi niz znakova + Enter postaje očitani kod. Enter se tada ne propušta dalje,
 * pa čitač ne „klikne" gumb koji je slučajno u fokusu.
 */
export function useWedgeScanner(onCode: (code: string) => void, enabled = true) {
  const ref = useRef(onCode);
  ref.current = onCode;
  useEffect(() => {
    if (!enabled) return;
    const det = createWedgeDetector();
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target) || e.ctrlKey || e.metaKey || e.altKey) {
        det.reset();
        return;
      }
      const code = det.key(e.key, e.timeStamp || performance.now());
      if (code) {
        e.preventDefault();
        e.stopPropagation();
        ref.current(code);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}

/** Uređaj s dodirom (mobitel) — tamo polje ne preuzima fokus jer bi otvorilo tipkovnicu. */
const coarsePointer = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

/**
 * Polje za kod: tipkanje + Enter, ručni čitač (tipka u polje i šalje Enter) i
 * gumb kamere. Na računalu polje drži fokus da čitač uvijek „piše" u njega.
 */
export function ScanInput({
  onScan,
  placeholder = 'Serijski broj ili barkod…',
  keepFocus = true,
  camera = true,
  cameraTitle = 'Skeniranje kamerom',
  disabled,
  className,
  size = 'md',
  submitLabel = 'Dodaj',
}: {
  onScan: (code: string) => void;
  placeholder?: string;
  keepFocus?: boolean;
  camera?: boolean;
  cameraTitle?: string;
  disabled?: boolean;
  className?: string;
  size?: 'md' | 'lg';
  submitLabel?: string;
}) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const focusable = keepFocus && !coarsePointer();

  useEffect(() => {
    if (focusable && !open) input.current?.focus();
  }, [focusable, open]);

  const submit = () => {
    const code = value.trim();
    if (!code) return;
    setValue('');
    onScan(code);
    if (focusable) input.current?.focus();
  };

  return (
    <div className={cn('flex gap-2', className)}>
      <form
        className="flex min-w-0 flex-1 gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Keyboard className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-4" />
          <input
            ref={input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => {
              // vrati fokus ako korisnik nije otišao u drugo polje (čitač piše u fokusirano polje)
              if (focusable && !open) setTimeout(() => !isEditable(document.activeElement) && !document.querySelector('dialog[open]') && input.current?.focus(), 150);
            }}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-label="Kod za skeniranje"
            data-scan-input
            className={cn(controlClass, 'pl-8 font-mono', size === 'lg' ? 'h-12 text-md' : 'h-8')}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={disabled || !value.trim()} className={size === 'lg' ? 'h-12' : undefined}>
          {submitLabel}
        </Button>
      </form>
      {camera && (
        <>
          <Button
            variant="primary"
            icon={<ScanLine className="size-4" />}
            className={size === 'lg' ? 'h-12' : undefined}
            onClick={() => setOpen(true)}
            disabled={disabled}
            aria-label="Skeniraj kamerom"
          >
            <span className="max-sm:hidden">Kamera</span>
          </Button>
          <ScanDialog open={open} onClose={() => setOpen(false)} onCode={onScan} title={cameraTitle} />
        </>
      )}
    </div>
  );
}

/**
 * Dijalog s kamerom za neprekidno skeniranje u obrazac: svaki kod ide u
 * `onCode`, dijalog ostaje otvoren dok korisnik ne pritisne „Gotovo".
 */
export function ScanDialog({
  open,
  onClose,
  onCode,
  title = 'Skeniranje kamerom',
  hint,
}: {
  open: boolean;
  onClose: () => void;
  onCode: (code: string) => void;
  title?: string;
  hint?: ReactNode;
}) {
  const [codes, setCodes] = useState<string[]>([]);
  useEffect(() => {
    if (open) setCodes([]);
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <Button variant="primary" onClick={onClose}>
          Gotovo{codes.length ? ` (${codes.length})` : ''}
        </Button>
      }
    >
      {open && (
        <div className="space-y-3">
          <Scanner
            autoStart
            height="h-64 sm:h-72"
            onCode={(c) => {
              setCodes((v) => [c, ...v.filter((x) => x !== c)]);
              onCode(c);
            }}
          />
          {hint && <p className="text-sm text-fg-3">{hint}</p>}
          {codes.length > 0 ? (
            <div>
              <p className="mb-1 text-sm text-fg-3">Očitano ({codes.length}):</p>
              <ul className="max-h-40 space-y-1 overflow-y-auto scroll-slim">
                {codes.map((c) => (
                  <li key={c} className="truncate rounded bg-muted px-2 py-1 font-mono text-sm">
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-fg-3">Usmjerite kameru na barkod ili QR kod. Svaki novi kod se odmah dodaje.</p>
          )}
        </div>
      )}
    </Dialog>
  );
}
