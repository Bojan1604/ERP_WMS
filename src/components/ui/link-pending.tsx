'use client';

import type { ReactNode } from 'react';
import { useLinkStatus } from 'next/link';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Unutar <Link>: dok se stranica učitava prikazuje vrtuljak umjesto sadržaja
 * (ili uz njega), da klik na karticu ili stranicu ima vidljiv odziv.
 */
export function LinkPending({ children, className }: { children?: ReactNode; className?: string }) {
  const { pending } = useLinkStatus();
  if (children === undefined) return pending ? <Loader2 className={cn('size-3.5 animate-spin text-fg-3', className)} /> : null;
  return pending ? <Loader2 className={cn('size-4 animate-spin', className)} /> : <>{children}</>;
}
