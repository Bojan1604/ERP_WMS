'use client';

import { useState } from 'react';
import { LogOut, Tag, Trash2, Undo2, ArrowRightLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AnnounceReturnDialog, MarkOutDialog, StatusDialog, TransferDialog, WriteOffDialog,
  type Perms, type WarehouseOptions,
} from './dialogs';
import { MOVABLE_STATES, NO_WRITE_OFF_STATES, type StateKind } from '@/domain/warehouse';

type Which = 'status' | 'out' | 'writeoff' | 'return' | 'transfer' | null;

/** Radnje na kartici uređaja. */
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
  const [which, setWhich] = useState<Which>(null);
  if (!perms.canOps) return null;
  const base = { open: true, onClose: () => setWhich(null), itemIds: [itemId] };
  const meta = { count: 1, onContract: onContract ? 1 : 0, cost };
  return (
    <>
      <Button icon={<Tag className="size-4" />} onClick={() => setWhich('status')}>
        Promijeni status
      </Button>
      {state === 'IN_STOCK' && (
        <Button icon={<LogOut className="size-4" />} className="border-0 bg-warn-soft text-warn" onClick={() => setWhich('out')}>
          Izašlo iz skladišta
        </Button>
      )}
      {state === 'RENTED' && (
        <Button icon={<Undo2 className="size-4" />} onClick={() => setWhich('return')}>
          Najavi povrat
        </Button>
      )}
      {perms.canEdit && MOVABLE_STATES.includes(state) && (
        <Button icon={<ArrowRightLeft className="size-4" />} onClick={() => setWhich('transfer')}>
          Premjesti
        </Button>
      )}
      {perms.canEdit && !NO_WRITE_OFF_STATES.includes(state) && (
        <Button variant="ghost" icon={<Trash2 className="size-4" />} className="text-bad-strong" onClick={() => setWhich('writeoff')}>
          Otpiši
        </Button>
      )}
      {which === 'status' && <StatusDialog {...base} statuses={options.statuses} warehouses={options.warehouses} perms={perms} meta={meta} />}
      {which === 'out' && <MarkOutDialog {...base} count={1} />}
      {which === 'return' && <AnnounceReturnDialog {...base} count={1} />}
      {which === 'transfer' && <TransferDialog {...base} warehouses={options.warehouses} count={1} />}
      {which === 'writeoff' && <WriteOffDialog {...base} meta={meta} />}
    </>
  );
}
