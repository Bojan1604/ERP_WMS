import { cn } from '@/lib/cn';
import { SLOT_BG } from './palette';

/** Legenda — boja je samo ključ uz tekst; tekst ostaje u bojama teksta. */
export function Legend({ items, className }: { items: Array<{ label: string; slot: number; line?: boolean }>; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-2', className)}>
      {items.map((i) => (
        <li key={i.label} className="inline-flex items-center gap-1.5">
          <span className={cn(i.line ? 'h-0.5 w-3.5 rounded-full' : 'size-2.5 rounded-sm', SLOT_BG[i.slot % SLOT_BG.length])} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
