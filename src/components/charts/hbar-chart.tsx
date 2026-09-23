import { cn } from '@/lib/cn';
import { amount } from '@/lib/format';
import { SLOT_BG } from './palette';

/**
 * Vodoravni stupci za rang-liste (top kupci, modeli…) — jedna serija, pa bez
 * legende; vrijednost stoji na kraju stupca u boji teksta.
 */
export function HBarChart({
  rows,
  format = (v: number) => `${amount(v)} €`,
  slot = 0,
  className,
}: {
  rows: Array<{ label: string; value: number; href?: string }>;
  format?: (v: number) => string;
  slot?: number;
  className?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className={cn('space-y-1.5', className)}>
      {rows.map((r, i) => (
        <li key={`${r.label}-${i}`} className="group grid grid-cols-[minmax(0,11rem)_1fr] items-center gap-3 text-sm" title={`${r.label}: ${format(r.value)}`}>
          <span className="truncate text-fg-2">{r.href ? <a href={r.href} className="hover:underline">{r.label}</a> : r.label}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn('h-3 shrink-0 rounded-r-[4px] transition-opacity group-hover:opacity-80', SLOT_BG[slot % 8])}
              style={{ width: `calc(${(Math.abs(r.value) / max) * 100}% - ${(Math.abs(r.value) / max) * 7}rem)`, minWidth: 2 }}
            />
            <span className="shrink-0 font-medium tnum text-fg">{format(r.value)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
