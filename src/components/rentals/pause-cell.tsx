'use client';

import { ActionButton } from '@/components/ui/action';
import type { ServerAction } from '@/components/ui/action';
import { amount } from '@/lib/format';
import { cn } from '@/lib/cn';

type Input = { contractId: string; itemId: string; period: string; paused: boolean };

/**
 * Ćelija rasporeda: klik pauzira naplatu uređaja u tom razdoblju (rata se ne izdaje),
 * ponovni klik je vraća. Fakturirana razdoblja se ne mogu pauzirati.
 */
export function PauseCell({
  action,
  contractId,
  itemId,
  serial,
  period,
  label,
  value,
  paused,
}: {
  action: ServerAction<Input>;
  contractId: string;
  itemId: string;
  serial: string;
  period: string;
  label: string;
  value: number;
  paused: boolean;
}) {
  return (
    <ActionButton
      action={action}
      input={{ contractId, itemId, period, paused: !paused }}
      size="sm"
      variant="ghost"
      className={cn('h-6 w-full justify-end px-1 tnum', paused && 'text-warn line-through decoration-1')}
      title={paused ? `Pauzirano — klik vraća naplatu` : 'Klik: ne naplaćivati ovaj uređaj u ovom razdoblju'}
      confirmTitle={paused ? 'Vratiti naplatu?' : 'Pauza naplate'}
      confirmLabel={paused ? 'Vrati naplatu' : 'Pauziraj'}
      confirm={
        paused ? (
          <>
            Uređaj <b className="font-mono">{serial}</b> će se ponovno naplatiti za <b>{label}</b> ({amount(value)} €).
          </>
        ) : (
          <>
            Uređaj <b className="font-mono">{serial}</b> se <b>neće naplatiti</b> za <b>{label}</b> ({amount(value)} €). Rata se ne pojavljuje u
            „Rate za izdati" ni u pregledu najma. Ostali mjeseci i uređaji se naplaćuju normalno.
          </>
        )
      }
    >
      {amount(value)}
    </ActionButton>
  );
}
