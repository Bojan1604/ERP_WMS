import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { queryWithout, type SearchParams, type SortDir } from '@/lib/list-params';

/**
 * Zaglavlje stupca koje sortira popis preko `?sort=stupac&dir=asc|desc`.
 * Klik na neaktivni stupac → `defaultDir`, ponovni klik okreće smjer. Ostali
 * filtri ostaju, straničenje se vraća na prvu stranicu. Radi i u poslužiteljskoj
 * i u klijentskoj komponenti. Stupac mora biti na popisu dopuštenih u `parseSort`.
 */
export function SortHeader({
  label,
  field,
  params,
  basePath,
  defaultDir = 'asc',
  align,
  className,
  title,
}: {
  label: string;
  field: string;
  /** searchParams stranice (ili URLSearchParams na klijentu). */
  params: SearchParams | URLSearchParams;
  basePath: string;
  defaultDir?: SortDir;
  align?: 'left' | 'right' | 'center';
  className?: string;
  title?: string;
}) {
  const q = queryWithout(params, ['page', 'sort', 'dir']);
  const curSort = params instanceof URLSearchParams ? params.get('sort') : params.sort;
  const curDir = params instanceof URLSearchParams ? params.get('dir') : params.dir;
  const active = curSort === field;
  const dir: SortDir = active ? (curDir === 'desc' ? 'desc' : 'asc') : defaultDir;
  q.set('sort', field);
  q.set('dir', active ? (dir === 'asc' ? 'desc' : 'asc') : defaultDir);
  const Icon = !active ? ArrowUpDown : dir === 'desc' ? ArrowDown : ArrowUp;
  return (
    <th className={cn(align === 'right' && 'num', align === 'center' && 'text-center', className)} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <Link
        prefetch={false}
        scroll={false}
        href={`${basePath}?${q}`}
        title={title}
        className={cn('inline-flex items-center gap-1 hover:text-fg', align === 'right' && 'flex-row-reverse', active && 'text-fg')}
      >
        {label}
        <Icon className={cn('size-3 shrink-0', !active && 'opacity-40')} />
      </Link>
    </th>
  );
}
