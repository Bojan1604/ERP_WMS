'use client';

import { useEffect, useRef, useState, type InputHTMLAttributes, type Ref } from 'react';
import { Paperclip } from 'lucide-react';
import { buttonClass } from './button';
import { cn } from '@/lib/cn';

/**
 * Odabir datoteke na hrvatskom — zamjena za nativni `<input type="file">` („Choose File / No file chosen"
 * ovisi o jeziku preglednika). Pravo polje ostaje u obrascu (name, required, accept, onChange rade kao inače),
 * samo je vizualno skriveno; gumb ga otvara, a pokraj njega piše naziv odabrane datoteke.
 * Radi i unutar `<Field>` (oznaka): gumb je type="button" pa ga `stopLabelActivation` ne udvostručuje.
 */
export function FileInput({
  ref,
  className,
  buttonLabel = 'Odaberi datoteku',
  emptyLabel = 'Nije odabrana datoteka',
  onChange,
  disabled,
  ...p
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { ref?: Ref<HTMLInputElement>; buttonLabel?: string; emptyLabel?: string }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [names, setNames] = useState<string[]>([]);

  // poništavanje obrasca (npr. resetOnSuccess) briše i prikazani naziv
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const onReset = () => setNames([]);
    form.addEventListener('reset', onReset);
    return () => form.removeEventListener('reset', onReset);
  }, []);

  const setRef = (el: HTMLInputElement | null) => {
    input.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  const n = names.length;
  const shown = n > 1 ? `${n} ${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'datoteke' : 'datoteka'}` : names[0];
  return (
    <span className={cn('relative flex min-w-0 items-center gap-2', className)}>
      <button type="button" disabled={disabled} className={buttonClass('secondary', 'sm', 'shrink-0')} onClick={() => input.current?.click()}>
        <Paperclip className="size-3.5" />
        {buttonLabel}
      </button>
      <span className={cn('min-w-0 truncate text-sm', shown ? 'text-fg' : 'text-fg-3')} title={names.join(', ') || undefined}>
        {shown ?? emptyLabel}
      </span>
      <input
        {...p}
        ref={setRef}
        type="file"
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          setNames([...(e.target.files ?? [])].map((f) => f.name));
          onChange?.(e);
        }}
      />
    </span>
  );
}
