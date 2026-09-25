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
      <p className={cn('mt-1 whitespace-nowrap text-md font-semibold tracking-tight tnum @[11rem]:text-lg @[15rem]:text-xl', tone === 'bad' && 'text-bad-strong', tone === 'ok' && 'text-ok')}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-fg-3">{hint}</p>}
    </>
  );
  // @container: veličina iznosa prema širini pločice (8-znamenkasti iznos s „€" ostaje u jednom retku)
  const cls = '@container block min-w-0 rounded-lg bg-panel px-4 py-3.5 shadow-[var(--shadow-panel)]';
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

const NOTICE_TONE: Record<'bad' | 'warn' | 'info' | 'brand', { bar: string; pill: string }> = {
  bad: { bar: 'border-l-bad-strong', pill: 'bg-bad-soft text-bad-strong' },
  warn: { bar: 'border-l-warn', pill: 'bg-warn-soft text-warn' },
  info: { bar: 'border-l-info', pill: 'bg-info-soft text-info' },
  brand: { bar: 'border-l-brand', pill: 'bg-brand/10 text-brand' },
};

/** Traka obavijesti na vrhu ploče (nove prijave, povrat s terena, zaprimanje, sigurnosna kopija). */
export function NoticeBar({ tone, tag, title, detail, href, linkLabel }: { tone: keyof typeof NOTICE_TONE; tag: string; title: ReactNode; detail?: ReactNode; href?: string; linkLabel?: string }) {
  const t = NOTICE_TONE[tone];
  const inner = (
    <>
      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', t.pill)}>{tag}</span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-fg">{title}</span>
        {detail && <span className="block truncate text-xs text-fg-3 sm:ml-2 sm:inline">{detail}</span>}
      </span>
      {href && (
        <span className="hidden shrink-0 items-center gap-1 text-sm text-brand sm:inline-flex">
          {linkLabel ?? 'Otvori'} <ArrowRight className="size-3.5" />
        </span>
      )}
    </>
  );
  const cls = cn('flex items-center gap-3 rounded-lg border-l-4 bg-panel px-4 py-2.5 text-sm shadow-[var(--shadow-panel)]', t.bar);
  return href ? (
    <Link prefetch={false} href={href} className={cn(cls, 'hover:bg-panel-2')}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
