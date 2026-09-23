import { eur, pct } from '@/lib/format';
import type { DocumentTotals } from '@/domain/invoice';
import { cn } from '@/lib/cn';

/** Zbrojevi u editoru (živo, iz `documentTotals`). */
export function TotalsBox({ t, vatRate, advance = 0, className }: { t: DocumentTotals; vatRate: number; advance?: number; className?: string }) {
  const rows: Array<[string, number, boolean?]> = [['Stavke', t.linesNet]];
  if (t.discount) rows.push(['Popust', -t.discount]);
  rows.push(['Osnovica', t.net], [`PDV ${pct(vatRate)}`, t.vat]);
  if (t.charges) rows.push(['Neoporezive naknade', t.charges]);
  rows.push(['Ukupno', t.total, true]);
  if (advance) rows.push(['Uračunati predujam', -advance], ['Za platiti', Math.max(0, t.total - advance), true]);
  return (
    <dl className={cn('text-base', className)}>
      {rows.map(([k, v, strong]) => (
        <div key={k} className={cn('flex justify-between gap-6 py-1', strong && 'mt-1 border-t border-line-strong pt-2 text-md font-semibold')}>
          <dt className={strong ? '' : 'text-fg-3'}>{k}</dt>
          <dd className="tnum">{eur(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
