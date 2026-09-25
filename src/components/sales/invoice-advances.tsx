'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAction } from '@/components/ui/action';
import { eur } from '@/lib/format';
import { formatDate } from '@/domain/dates';
import { r2 } from '@/domain/money';
import { partnerAdvances } from '@/app/(app)/prodaja/racuni/actions';
import { NumberInput } from './inputs';

export interface AdvanceChoice {
  advanceId: string;
  amount: number;
}

interface AdvanceOpt {
  id: string;
  number: string | null;
  date: string;
  total: number;
  used: number;
  remaining: number;
}

/**
 * „Uračunati predujam": izdani računi za predujam kupca s neiskorištenim ostatkom.
 * Uračunava se iznos s PDV-om, najviše ostatak predujma i ukupno računa; konačni
 * račun u eRačunu nosi BillingReference na svaki odabrani predujam.
 */
export function AdvancePicker({
  partnerId,
  invoiceId,
  value,
  onChange,
  maxTotal,
}: {
  partnerId: string | null;
  invoiceId: string | null;
  value: AdvanceChoice[];
  onChange: (v: AdvanceChoice[]) => void;
  /** Ukupno računa — zbroj uračunatog ga ne prelazi. */
  maxTotal: number;
}) {
  const [list, setList] = useState<AdvanceOpt[]>([]);
  const load = useAction(partnerAdvances, { refresh: false });
  useEffect(() => {
    setList([]);
    if (!partnerId) return;
    let live = true;
    load.run({ partnerId, invoiceId }).then((r) => {
      if (live && r.ok) setList((r.data ?? []) as AdvanceOpt[]);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId, invoiceId]);

  const chosen = new Map(value.map((v) => [v.advanceId, v.amount]));
  const toggle = (a: AdvanceOpt, on: boolean) => {
    if (!on) return onChange(value.filter((v) => v.advanceId !== a.id));
    const others = value.reduce((s, v) => s + v.amount, 0);
    const amount = r2(Math.max(0, Math.min(a.remaining, maxTotal - others)));
    onChange([...value, { advanceId: a.id, amount: amount || a.remaining }]);
  };

  return (
    <div>
      <p className="mb-1 text-sm font-medium text-fg-2">Uračunati predujam</p>
      {!partnerId ? (
        <p className="text-sm text-fg-3">Odaberite kupca.</p>
      ) : !list.length ? (
        <p className="text-sm text-fg-3">{load.pending ? 'Učitavanje…' : 'Kupac nema izdanih računa za predujam s neiskorištenim iznosom.'}</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((a) => {
            const on = chosen.has(a.id);
            return (
              <li key={a.id} className="grid grid-cols-[1.25rem_1fr_7.5rem] items-center gap-2 text-sm">
                <input type="checkbox" checked={on} onChange={(e) => toggle(a, e.target.checked)} aria-label={`Uračunaj predujam ${a.number ?? ''}`} />
                <span className="min-w-0">
                  <Link prefetch={false} href={`/prodaja/racuni/${a.id}`} className="link" target="_blank">
                    {a.number}
                  </Link>{' '}
                  <span className="text-fg-3">
                    od {formatDate(a.date)} · ostatak {eur(a.remaining)}
                    {a.used > 0 ? ` od ${eur(a.total)}` : ''}
                  </span>
                </span>
                {on ? (
                  <NumberInput
                    value={chosen.get(a.id) ?? 0}
                    onValue={(x) => onChange(value.map((v) => (v.advanceId === a.id ? { ...v, amount: r2(x ?? 0) } : v)))}
                    aria-label="Uračunati iznos (s PDV-om)"
                  />
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
