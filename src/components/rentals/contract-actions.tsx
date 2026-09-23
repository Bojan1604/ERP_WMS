'use client';

import { useState } from 'react';
import { CalendarX, Pause, Play, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { ActionButton, useAction } from '@/components/ui/action';
import type { ContractStatusCode } from '@/domain/billing';
import { contractStatusAction, terminateAction } from '@/app/(app)/najam/ugovori/actions';

/** Radnje statusa ugovora: pauza/nastavak, istek i otkaz. */
export function ContractStatusActions({
  id,
  number,
  status,
  rented,
  pending,
}: {
  id: string;
  number: string;
  status: ContractStatusCode;
  /** Broj uređaja u najmu (za „najavi povrat odmah"). */
  rented: number;
  /** Broj rata koje još nisu izdane. */
  pending: number;
}) {
  const [ask, setAsk] = useState(false);
  const [returnNow, setReturnNow] = useState(true);
  const terminate = useAction(terminateAction, { onSuccess: () => setAsk(false) });
  if (status !== 'ACTIVE' && status !== 'PAUSED') return null;
  return (
    <>
      {status === 'ACTIVE' ? (
        <ActionButton action={contractStatusAction} input={{ id, status: 'PAUSED' as const }} icon={<Pause className="size-4" />} confirm="Pauzirani ugovor ne stvara nove rate dok se ne nastavi." confirmLabel="Pauziraj">
          Pauziraj
        </ActionButton>
      ) : (
        <ActionButton action={contractStatusAction} input={{ id, status: 'ACTIVE' as const }} icon={<Play className="size-4" />}>
          Nastavi
        </ActionButton>
      )}
      <ActionButton
        action={contractStatusAction}
        input={{ id, status: 'EXPIRED' as const }}
        icon={<CalendarX className="size-4" />}
        confirm="Ugovor se označava kao istekao: rate se više ne traže, a uvjeti se ne mogu mijenjati. Uređaje vratite kroz „Ukloni s ugovora“."
        confirmLabel="Označi kao istekao"
      >
        Istekao
      </ActionButton>
      <Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => setAsk(true)}>
        Otkaži ugovor
      </Button>
      <Dialog
        open={ask}
        onClose={() => setAsk(false)}
        title={`Otkaži ugovor ${number}`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setAsk(false)}>Odustani</Button>
            <Button variant="danger" loading={terminate.pending} onClick={() => terminate.run({ id, returnNow: rented > 0 && returnNow })}>
              Otkaži ugovor
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-base text-fg-2">
          <p>Ugovor prelazi u status <b>Raskinut</b> s današnjim datumom kao krajem. Izdani računi ostaju nepromijenjeni.</p>
          {pending > 0 && (
            <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
              Ugovor ima {pending} neizdanih rata — nakon otkaza više se neće tražiti. Izdajte ih prije otkaza ako ih treba naplatiti.
            </p>
          )}
          {rented > 0 ? (
            <Checkbox label={`Najavi povrat odmah (${rented} uređaja → „U dolasku")`} checked={returnNow} onChange={(e) => setReturnNow(e.target.checked)} />
          ) : (
            <p className="text-sm text-fg-3">Na ugovoru nema uređaja u najmu.</p>
          )}
        </div>
      </Dialog>
    </>
  );
}
