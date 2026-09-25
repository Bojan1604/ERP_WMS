import Link from 'next/link';
import { redirect, RedirectType } from 'next/navigation';
import { LinkPending } from './link-pending';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { integer } from '@/lib/format';

/**
 * Straničenje na poslužitelju — poveznice zadržavaju ostale filtre. Stranica iza zadnje
 * (`?page=99999`, ili nakon brisanja/filtra) preusmjerava na zadnju; prazan popis nema traku.
 */
export function Pagination({
  page,
  pageSize,
  total,
  params,
  basePath,
}: {
  page: number;
  pageSize: number;
  total: number;
  params: Record<string, string | string[] | undefined>;
  basePath: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v && k !== 'page') q.set(k, v);
    if (p > 1) q.set('page', String(p));
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  if (page > pages) redirect(href(pages), RedirectType.replace);
  if (!total) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const btn = 'grid size-7 place-items-center rounded-md border border-line-strong bg-panel';
  return (
    <div className="no-print mt-3 flex items-center justify-between text-sm text-fg-3">
      <span>
        {integer(from)}–{integer(to)} od {integer(total)}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-1.5">
          {page > 1 ? (
            <Link href={href(page - 1)} className={cn(btn, 'hover:bg-muted')} aria-label="Prethodna">
              <LinkPending>
                <ChevronLeft className="size-4" />
              </LinkPending>
            </Link>
          ) : (
            <span className={cn(btn, 'opacity-40')}>
              <ChevronLeft className="size-4" />
            </span>
          )}
          <span className="px-1">
            {page} / {pages}
          </span>
          {page < pages ? (
            <Link href={href(page + 1)} className={cn(btn, 'hover:bg-muted')} aria-label="Sljedeća">
              <LinkPending>
                <ChevronRight className="size-4" />
              </LinkPending>
            </Link>
          ) : (
            <span className={cn(btn, 'opacity-40')}>
              <ChevronRight className="size-4" />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function readPage(params: Record<string, string | string[] | undefined>, pageSize = 50) {
  const page = Math.max(1, Number(params.page) || 1);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
