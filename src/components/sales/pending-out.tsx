'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, FileSignature, Receipt, Repeat, Undo2 } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { ActionButton } from '@/components/ui/action';
import { integer } from '@/lib/format';
import { cancelOutAction } from '@/app/(app)/skladiste/izlaz/actions';

export interface PendingOutGroup {
  partnerId: string | null;
  partnerName: string | null;
  count: number;
  itemIds: string[];
}

/**
 * „Izlaz iz skladišta čeka potvrdu" na ekranu prodaje: uređaji koji su izašli
 * iz skladišta, po kupcu kojem idu, s radnjama Račun / Najam / Na ugovor / Vrati.
 */
export function PendingOutNotice({ total, groups, canRent, canReturn }: { total: number; groups: PendingOutGroup[]; canRent: boolean; canReturn: boolean }) {
  const [open, setOpen] = useState(groups.length <= 3);
  const btn = buttonClass('secondary', 'sm');
  return (
    <div className="mb-3 rounded-lg bg-warn-soft px-3.5 py-2.5 text-base text-warn">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <b>Izlaz iz skladišta čeka potvrdu:</b> {integer(total)} uređaja — račun, najam, ugovor ili povratak na stanje.
        </span>
        <span className="flex items-center gap-2">
          <Link prefetch={false} href="/skladiste/izlaz" className="text-sm underline">
            Izlaz i povrat
          </Link>
          {groups.length > 3 && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-sm underline">
              {open ? 'Sakrij' : `Po kupcima (${groups.length})`}
              <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          )}
        </span>
      </div>
      {open && (
        <ul className="mt-2 divide-y divide-warn/20 text-fg">
          {groups.map((g) => {
            const qs = `items=${g.itemIds.join(',')}${g.partnerId ? `&partner=${g.partnerId}` : ''}`;
            return (
              <li key={g.partnerId ?? '-'} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate">
                  <b>{g.partnerName ?? 'Bez kupca'}</b> <span className="text-fg-3">· {integer(g.count)} kom</span>
                </span>
                <Link prefetch={false} href={`/prodaja/racuni/novi?${qs}`} className={btn}>
                  <Receipt className="size-3.5" />
                  Račun
                </Link>
                <Link prefetch={false} href={`/prodaja/racuni/novi?${qs}&vrsta=najam`} className={btn}>
                  <Repeat className="size-3.5" />
                  Najam
                </Link>
                {canRent && (
                  <Link prefetch={false} href={`/najam/ugovori/novi?${qs}`} className={btn}>
                    <FileSignature className="size-3.5" />
                    Na ugovor
                  </Link>
                )}
                {canReturn && (
                  <ActionButton
                    size="sm"
                    variant="ghost"
                    icon={<Undo2 className="size-3.5" />}
                    action={cancelOutAction}
                    input={{ itemIds: g.itemIds }}
                    confirm={`Vratiti ${g.itemIds.length} kom na skladište? Izlaz se poništava.`}
                    confirmLabel="Vrati na skladište"
                  >
                    Vrati
                  </ActionButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
