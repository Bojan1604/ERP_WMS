'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Boxes, LayoutDashboard, Menu, Receipt, ScanLine, Smartphone } from 'lucide-react';
import { cn } from '@/lib/cn';
import { can, type PermissionMap } from '@/domain/permissions';

/**
 * Donja traka na mobitelu: najčešća odredišta na dohvat palca. Puni izbornik
 * otvara gumb „Izbornik" (isti kao gumb u zaglavlju).
 */
export function MobileNav({ perms }: { perms: PermissionMap }) {
  const pathname = usePathname();
  const items = [
    { href: '/', label: 'Početna', icon: LayoutDashboard, show: can(perms, 'dashboard') },
    { href: '/skladiste', label: 'Skladište', icon: Boxes, show: can(perms, 'warehouse') },
    { href: '/skladiste/skeniranje', label: 'Skeniraj', icon: ScanLine, show: can(perms, 'warehouse'), primary: true },
    { href: '/prodaja/racuni', label: 'Računi', icon: Receipt, show: can(perms, 'sales') },
    // vanjski korisnici (bez ERP-a): MDM na dohvat palca
    { href: '/mdm', label: 'Pregled', icon: LayoutDashboard, show: !can(perms, 'dashboard') && can(perms, 'mdm') },
    { href: '/mdm/uredaji', label: 'Uređaji', icon: Smartphone, show: !can(perms, 'warehouse') && can(perms, 'mdm') },
  ].filter((i) => i.show);
  const active = (href: string) => (href === '/' ? pathname === '/' : pathname === href || (pathname.startsWith(`${href}/`) && !items.some((o) => o.href !== href && o.href.startsWith(href) && pathname.startsWith(o.href))));

  return (
    <nav className="no-print fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          className={cn('flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-xs', active(i.href) ? 'text-brand' : 'text-fg-3')}
        >
          {i.primary ? (
            <span className="-mt-5 grid size-12 place-items-center rounded-full bg-brand text-white shadow-[var(--shadow-pop)]">
              <i.icon className="size-5.5" />
            </span>
          ) : (
            <i.icon className="size-5" />
          )}
          <span className={cn(i.primary && 'font-medium')}>{i.label}</span>
        </Link>
      ))}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event('open-nav'))}
        className="flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-xs text-fg-3"
      >
        <Menu className="size-5" />
        <span>Izbornik</span>
      </button>
    </nav>
  );
}
