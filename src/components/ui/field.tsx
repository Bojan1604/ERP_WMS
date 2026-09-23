import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const controlClass =
  'w-full rounded-md border border-line-strong bg-panel px-2.5 text-base text-fg placeholder:text-fg-4 ' +
  'transition-[border-color,box-shadow] focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 ' +
  'disabled:bg-muted disabled:text-fg-3';

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
    <label className={cn('block min-w-0', className)}>
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

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cn(controlClass, 'h-8', p.type === 'number' && 'text-right', className)} />;
}

export function Textarea({ className, rows = 3, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} {...p} className={cn(controlClass, 'py-1.5', className)} />;
}

export interface Option {
  value: string;
  label: string;
}

export function Select({
  options,
  placeholder,
  className,
  ...p
}: SelectHTMLAttributes<HTMLSelectElement> & { options: Option[]; placeholder?: string }) {
  return (
    <select {...p} className={cn(controlClass, 'h-8 pr-7', className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ label, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2 text-base', className)}>
      <input type="checkbox" {...p} className="size-4 rounded accent-[var(--color-brand)]" />
      {label}
    </label>
  );
}

/** Mreža polja obrasca. */
export function FormGrid({ children, cols = 2, className }: { children: ReactNode; cols?: 1 | 2 | 3 | 4; className?: string }) {
  const c = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4' }[cols];
  return <div className={cn('grid grid-cols-1 gap-3', c, className)}>{children}</div>;
}
