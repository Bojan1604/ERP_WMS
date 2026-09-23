'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WriteOffDialog, type Perms, type WarehouseOptions } from './dialogs';
import { ScanActions } from './scan-actions';
import { NO_WRITE_OFF_STATES, type StateKind } from '@/domain/warehouse';

/**
 * Radnje na kartici uređaja — iste kao u skeniranju (izlaz, vraćanje, najava i
 * zaprimanje povrata, premještaj, status, naljepnica) i otpis.
 */
export function ItemActions({
  itemId,
  state,
  onContract,
  cost,
  options,
  perms,
}: {
  itemId: string;
  state: StateKind;
  onContract: boolean;
  cost: number;
  options: WarehouseOptions;
  perms: Perms;
}) {
  const [writeOff, setWriteOff] = useState(false);
  const router = useRouter();
  const meta = { count: 1, onContract: onContract ? 1 : 0, cost };
  return (
    <>
      <ScanActions targets={[{ id: itemId, state, onContract, cost }]} perms={perms} options={options} onDone={() => router.refresh()} />
      {perms.canEdit && !NO_WRITE_OFF_STATES.includes(state) && (
        <Button variant="ghost" icon={<Trash2 className="size-4" />} className="text-bad-strong" onClick={() => setWriteOff(true)}>
          Otpiši
        </Button>
      )}
      {writeOff && <WriteOffDialog open onClose={() => setWriteOff(false)} itemIds={[itemId]} meta={meta} />}
    </>
  );
}
