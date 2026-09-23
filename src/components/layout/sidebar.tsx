'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Loader2, Menu, Warehouse, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { can, type PermissionMap } from '@/domain/permissions';
import { NAV } from './nav';

function Icon({ icon: I, active }: { icon: LucideIcon; active: boolean }) {
  const { pending } = useLinkStatus();
  if (pending) return <Loader2 className="size-4 shrink-0 animate-spin" />;
  return <I className={cn('size-4 shrink-0', active ? 'text-white' : 'text-nav-fg-2')} />;
}

export function Sidebar({ perms, company, badges }: { perms: PermissionMap; company: string; badges: Record<string, number> }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // donja traka na mobitelu otvara isti izbornik
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('open-nav', onOpen);
    return () => window.removeEventListener('open-nav', onOpen);
  }, []);
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => can(perms, i.module, i.level ?? 'view')) })).filter((g) => g.items.length);

  // najdulja poklapajuća putanja je aktivna (/skladiste ne smije biti aktivan na /skladiste/izlaz)
  const all = groups.flatMap((g) => g.items.map((i) => i.href));
  const active = all.filter((h) => pathname === h || (h !== '/' && pathname.startsWith(`${h}/`))).sort((a, b) => b.length - a.length)[0];

  const nav = (
    <nav className="flex-1 overflow-y-auto scroll-slim px-2 pb-4">
      {groups.map((g) => (
        <div key={g.label || 'root'} className="mt-3">
          {g.label && <p className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wider text-nav-fg-2">{g.label}</p>}
          <ul className="space-y-px">
            {g.items.map((i) => {
              const on = i.href === active;
              return (
                <li key={i.href}>
                  <Link
                    href={i.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-base transition-colors',
                      on ? 'bg-brand text-white' : 'text-nav-fg hover:bg-nav-2 hover:text-white',
                    )}
                  >
                    <Icon icon={i.icon} active={on} />
                    <span className="flex-1 truncate">{i.label}</span>
                    {!!badges[i.href] && (
                      <span className={cn('rounded-full px-1.5 text-xs tnum', on ? 'bg-white/25 text-white' : 'bg-warn text-nav')}>{badges[i.href]}</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const brand = (
    <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
      <div className="grid size-8 place-items-center rounded-lg bg-brand text-white">
        <Warehouse className="size-4.5" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-md font-semibold text-white">ERP · WMS</p>
        <p className="truncate text-xs text-nav-fg-2">{company}</p>
      </div>
    </div>
  );

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="no-print fixed left-3 top-3 z-40 grid size-9 place-items-center rounded-md bg-nav text-white lg:hidden" aria-label="Izbornik">
        <Menu className="size-4.5" />
      </button>
      <aside className="no-print hidden w-60 shrink-0 flex-col bg-nav lg:flex">
        {brand}
        {nav}
      </aside>
      {open && (
        <div className="no-print fixed inset-0 z-50 flex lg:hidden">
          <aside className="flex w-64 flex-col bg-nav">
            <div className="flex items-center justify-between pr-2">
              {brand}
              <button type="button" onClick={() => setOpen(false)} className="text-nav-fg" aria-label="Zatvori">
                <X className="size-5" />
              </button>
            </div>
            {nav}
          </aside>
          <button type="button" className="flex-1 bg-black/40" onClick={() => setOpen(false)} aria-label="Zatvori izbornik" />
        </div>
      )}
    </>
  );
}
