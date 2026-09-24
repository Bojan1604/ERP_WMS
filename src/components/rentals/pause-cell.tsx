'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useAction, type ServerAction } from '@/components/ui/action';
import { amount } from '@/lib/format';
import { periodLabel } from '@/domain/dates';

type Input = { contractId: string; itemId: string; period: string; paused: boolean };
type Ask = { itemId: string; serial: string; period: string; label: string; value: number; paused: boolean };

/**
 * Raspored s pauzom naplate: ćelije su obični gumbi s data-* atributima (renderira ih
 * poslužitelj; serijski broj je na retku), a jedan dijalog za cijelu tablicu hvata klik — i s tisuću uređaja × 12
 * mjeseci stranica ostaje lagana.
 */
export function PauseGrid({ action, contractId, children }: { action: ServerAction<Input>; contractId: string; children: ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const { run, pending } = useAction(action);
  return (
    <div
      onClick={(e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-period]');
        if (!b) return;
        const d = b.dataset;
        const period = d.period ?? '';
        const serial = b.closest<HTMLElement>('[data-serial]')?.dataset.serial ?? '';
        setAsk({ itemId: d.item ?? '', serial, period, label: periodLabel(period), value: Number(d.value), paused: d.paused === '1' });
      }}
    >
      {children}
      <Dialog
        open={!!ask}
        onClose={() => setAsk(null)}
        title={ask?.paused ? 'Vratiti naplatu?' : 'Pauza naplate'}
        size="sm"
        footer={
          <>
            <Button onClick={() => setAsk(null)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={async () => {
                if (!ask) return;
                const r = await run({ contractId, itemId: ask.itemId, period: ask.period, paused: !ask.paused });
                if (r.ok) setAsk(null);
              }}
            >
              {ask?.paused ? 'Vrati naplatu' : 'Pauziraj'}
            </Button>
          </>
        }
      >
        {ask && (
          <div className="text-base text-fg-2">
            {ask.paused ? (
              <>
                Uređaj <b className="font-mono">{ask.serial}</b> će se ponovno naplatiti za <b>{ask.label}</b> ({amount(ask.value)} €).
              </>
            ) : (
              <>
                Uređaj <b className="font-mono">{ask.serial}</b> se <b>neće naplatiti</b> za <b>{ask.label}</b> ({amount(ask.value)} €). Rata se ne pojavljuje u „Rate za izdati" ni u pregledu
                najma. Ostali mjeseci i uređaji se naplaćuju normalno.
              </>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
