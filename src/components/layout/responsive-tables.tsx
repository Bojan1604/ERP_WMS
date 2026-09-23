'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/** Svakoj ćeliji tablice kao oznaku dodaje naziv stupca iz zaglavlja (data-label). */
function label() {
  for (const table of document.querySelectorAll<HTMLTableElement>('table.data-table:not(.no-stack)')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
    for (const row of table.querySelectorAll<HTMLTableRowElement>('tbody tr, tfoot tr')) {
      let col = 0;
      for (const cell of row.cells) {
        const text = heads[col] ?? '';
        if (cell.dataset.label !== text) cell.dataset.label = text;
        col += cell.colSpan || 1;
      }
    }
  }
}

/**
 * Tablice podataka na mobitelu postaju kartice: svakoj ćeliji se kao oznaka
 * dodaje naziv stupca iz zaglavlja (data-label), a CSS (globals.css) ih
 * slaže jednu ispod druge. Radi za sve tablice s klasom `data-table` osim
 * onih s `no-stack` (mreže po mjesecima i slično).
 */
export function ResponsiveTables() {
  const pathname = usePathname();
  useEffect(() => {
    // oznake trebaju samo uskim ekranima; na računalu se HTML ne dira
    const mq = window.matchMedia('(max-width: 639px)');
    let obs: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (!mq.matches || obs) return;
      label();
      obs = new MutationObserver(() => requestAnimationFrame(label));
      obs.observe(document.body, { childList: true, subtree: true });
    };
    // pri prvom učitavanju tek kad React sigurno završi preuzimanje HTML-a (inače upozorenje o hidraciji)
    const later = () => {
      timer = setTimeout(start, 1200);
    };
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later, { once: true });
    const onChange = () => start();
    mq.addEventListener('change', onChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('load', later);
      mq.removeEventListener('change', onChange);
      obs?.disconnect();
    };
  }, [pathname]);
  return null;
}
