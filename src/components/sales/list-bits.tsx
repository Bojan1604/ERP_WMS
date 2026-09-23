import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import type { PaymentState } from '@/domain/invoice';

type Params = Record<string, string | string[] | undefined>;

/** Zaglavlje stupca koje prebacuje ?sort= (uzlazno → silazno); ostali filtri ostaju. */
export function SortHeader({
  label,
  field,
  params,
  basePath,
  className,
}: {
  label: string;
  field: string;
  params: Params;
  basePath: string;
  className?: string;
}) {
  const cur = typeof params.sort === 'string' ? params.sort : '';
  const active = cur === field || cur === `-${field}`;
  const desc = cur === `-${field}`;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v && k !== 'page' && k !== 'sort') q.set(k, v);
  q.set('sort', active && !desc ? `-${field}` : field);
  const Icon = !active ? ArrowUpDown : desc ? ArrowDown : ArrowUp;
  return (
    <th className={className}>
      <Link prefetch={false} href={`${basePath}?${q}`} scroll={false} className={cn('inline-flex items-center gap-1 hover:text-fg', active && 'text-fg')}>
        {label}
        <Icon className={cn('size-3', !active && 'opacity-40')} />
      </Link>
    </th>
  );
}

export const PAY_TONE: Record<PaymentState['tone'], Tone> = {
  neutral: 'neutral',
  positive: 'ok',
  warning: 'warn',
  negative: 'bad',
  info: 'info',
  accent: 'brand',
};

/** Stanje naplate kao pilula. */
export function PayBadge({ state }: { state: PaymentState }) {
  return <Badge tone={PAY_TONE[state.tone]}>{state.label}</Badge>;
}

/** Ton retka: crveno kasni, žuto otvoreno, zeleno plaćeno. */
export function rowTone(key: PaymentState['key']): string {
  switch (key) {
    case 'overdue':
      return '[&>td]:bg-bad-soft/45 [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-bad-strong)]';
    case 'open':
    case 'partial':
      return '[&>td]:bg-warn-soft/45 [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-warn)]';
    case 'paid':
      return '[&>td]:bg-ok-soft/35 [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-ok)]';
    case 'draft':
      return '[&>td]:text-fg-2 [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-line-strong)]';
    default:
      return '';
  }
}

export const TYPE_LABEL: Record<string, string> = { SALE: 'Prodaja', RENT: 'Najam', SERVICE: 'Usluga' };
export const KIND_SHORT: Record<string, string> = { INVOICE: 'Račun', ADVANCE: 'Predujam', STORNO: 'Storno', CREDIT_NOTE: 'Odobrenje' };
