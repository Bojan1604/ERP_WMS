'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Osvježava stranicu svakih `seconds` s dok je `active` (npr. naredba čeka uređaj) i kartica vidljiva. */
export function AutoRefresh({ active, seconds = 3 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [active, seconds, router]);
  return null;
}
