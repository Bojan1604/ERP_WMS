import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'bad' | 'info';

const TONE: Record<Tone, string> = {
  neutral: 'bg-muted text-fg-2',
  brand: 'bg-brand-soft text-brand',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad-strong',
  info: 'bg-info-soft text-info',
};

/** Boje statusa uređaja iz šifrarnika → ton. */
export const COLOR_TONE: Record<string, Tone> = {
  gray: 'neutral', green: 'ok', blue: 'info', purple: 'info', red: 'bad', amber: 'warn', teal: 'brand', orange: 'warn',
};

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-px text-xs font-medium whitespace-nowrap', TONE[tone], className)}>
      {children}
    </span>
  );
}

export function Card({ children, className, title, actions, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={cn('rounded-lg bg-panel shadow-[var(--shadow-panel)]', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
          <h2 className="text-md font-semibold">{title}</h2>
          {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn(padded && 'p-4')}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && <div className="mb-1 text-sm text-fg-3">{back}</div>}
        <h1 className="text-xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-fg-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
      {icon && <div className="mb-3 grid size-10 place-items-center rounded-full bg-muted text-fg-3">{icon}</div>}
      <p className="text-md font-medium">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-fg-3">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-lg bg-panel p-4 shadow-[var(--shadow-panel)]">
      <p className="text-sm text-fg-3">{label}</p>
      <p className={cn('mt-1 text-xl font-semibold tnum max-sm:text-lg', tone === 'bad' && 'text-bad-strong', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-fg-3">{hint}</p>}
    </div>
  );
}

export function Detail({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 border-b border-line/70 py-1.5 last:border-0', className)}>
      <dt className="shrink-0 text-sm text-fg-3">{label}</dt>
      <dd className="min-w-0 text-right">{children ?? '—'}</dd>
    </div>
  );
}

export function Notice({ tone = 'warn', children, action }: { tone?: Tone; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cn('mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3.5 py-2.5 text-base', TONE[tone])}>
      <div>{children}</div>
      {action}
    </div>
  );
}

/** Kontejner za tablicu s vodoravnim klizanjem. */
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-x-auto scroll-slim rounded-lg bg-panel shadow-[var(--shadow-panel)]', className)}>{children}</div>;
}
