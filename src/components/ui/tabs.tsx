'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/cn';
import { LinkPending } from './link-pending';

/** Kartice kao poveznice. `param` = kartice preko query parametra umjesto putanje. */
export function Tabs({ tabs, param }: { tabs: { href: string; label: string; count?: number }[]; param?: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const isActive = (href: string) => {
    if (param) {
      const v = new URL(href, 'http://x').searchParams.get(param) ?? '';
      return (params.get(param) ?? '') === v;
    }
    return pathname === href;
  };
  return (
    <nav className="no-print mb-4 flex gap-1 overflow-x-auto border-b border-line scroll-slim">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          prefetch={false}
          scroll={false}
          className={cn(
            '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-base',
            isActive(t.href) ? 'border-brand font-medium text-fg' : 'border-transparent text-fg-3 hover:text-fg',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-muted px-1.5 text-xs text-fg-2">{t.count}</span>}
          <LinkPending />
        </Link>
      ))}
    </nav>
  );
}
