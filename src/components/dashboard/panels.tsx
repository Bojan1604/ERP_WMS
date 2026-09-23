import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Tone } from '@/components/ui/misc';

/** Pokazatelj na vrhu ploče: naziv, iznos, pojašnjenje. */
export function KpiTile({ label, value, hint, href, tone }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: 'bad' | 'ok' }) {
  const body = (
    <>
      <p className="text-sm text-fg-3">{label}</p>
      <p className={cn('mt-1 text-lg font-semibold tracking-tight sm:text-xl', tone === 'bad' && 'text-bad-strong', tone === 'ok' && 'text-ok')}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-fg-3">{hint}</p>}
    </>
  );
  const cls = 'block min-w-0 rounded-lg bg-panel px-4 py-3.5 shadow-[var(--shadow-panel)]';
  return href ? (
    <Link prefetch={false} href={href} className={cn(cls, 'transition-colors hover:bg-panel-2')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const DOT: Record<Tone, string> = {
  neutral: 'bg-fg-4',
  brand: 'bg-brand',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad-strong',
  info: 'bg-info',
};

/**
 * Ploča s radnjom: broj stvari koje čekaju, kratki popis i poveznica. Kad je
 * broj 0, ploča se sažme u jedan redak.
 */
export function ActionPanel({
  title,
  count,
  tone = 'warn',
  href,
  linkLabel = 'Otvori',
  children,
  empty = 'Ništa ne čeka.',
}: {
  title: string;
  count: number;
  tone?: Tone;
  href?: string;
  linkLabel?: string;
  children?: ReactNode;
  empty?: string;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-lg bg-panel shadow-[var(--shadow-panel)]">
      <header className="flex items-center gap-2.5 px-4 pt-3 pb-2">
        <span className={cn('size-2 shrink-0 rounded-full', count ? DOT[tone] : 'bg-line-strong')} aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
        <span className={cn('text-lg font-semibold tnum', !count && 'text-fg-4')}>{count}</span>
      </header>
      <div className="min-h-0 flex-1 px-4 pb-2 text-sm">{count ? children : <p className="pb-1 text-fg-3">{empty}</p>}</div>
      {href && count > 0 && (
        <Link prefetch={false} href={href} className="flex items-center gap-1 border-t border-line px-4 py-2 text-sm text-brand hover:bg-panel-2">
          {linkLabel}
          <ArrowRight className="size-3.5" />
        </Link>
      )}
    </section>
  );
}

/** Redak u ploči: lijevo naziv, desno vrijednost. */
export function PanelRow({ href, left, sub, right }: { href?: string; left: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  const inner = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-fg">{left}</span>
        {sub && <span className="block truncate text-xs text-fg-3">{sub}</span>}
      </span>
      {right && <span className="shrink-0 text-right tnum text-fg-2">{right}</span>}
    </>
  );
  return (
    <li className="border-b border-line/70 last:border-0">
      {href ? (
        <Link prefetch={false} href={href} className="-mx-1.5 flex items-center gap-3 rounded px-1.5 py-1.5 hover:bg-panel-2">
          {inner}
        </Link>
      ) : (
        <div className="flex items-center gap-3 py-1.5">{inner}</div>
      )}
    </li>
  );
}
