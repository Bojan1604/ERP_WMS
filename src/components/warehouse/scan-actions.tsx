'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRightLeft, LogOut, PackageCheck, Pencil, Printer, Tag, Trash2, Undo2, Undo } from 'lucide-react';
import { Button, buttonClass } from '@/components/ui/button';
import { ActionButton } from '@/components/ui/action';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, type Option } from '@/components/ui/field';
import { FormError, useAction } from '@/components/ui/action';
import { cn } from '@/lib/cn';
import {
  sumCost,
  AnnounceReturnDialog, BulkEditDialog, MarkOutDialog, StatusDialog, TransferDialog, WriteOffDialog,
  type Perms, type WarehouseOptions,
} from './dialogs';
import { MOVABLE_STATES, NO_WRITE_OFF_STATES, RETURNABLE_STATES, type StateKind } from '@/domain/warehouse';
import { cancelOutAction, receiveReturnedAction } from '@/app/(app)/skladiste/izlaz/actions';

export interface ActionTarget {
  id: string;
  state: StateKind;
  onContract: boolean;
  /** Nabavna vrijednost; null bez prava `costs`. */
  cost: number | null;
}

type Which = 'status' | 'out' | 'return' | 'receive' | 'transfer' | 'edit' | 'writeoff' | null;

/** Adresa stranice s naljepnicama za zadane uređaje. */
export const labelsHref = (ids: string[]) => `/skladiste/naljepnice?ids=${ids.join(',')}`;

/**
 * Brze radnje nad jednim ili više skeniranih uređaja — iste kao traka radnji u
 * popisu skladišta. Radnja se nudi samo kad je dopuštena za sve odabrane.
 */
export function ScanActions({
  targets,
  perms,
  options,
  onDone,
  tone = 'light',
  bulk,
}: {
  targets: ActionTarget[];
  perms: Perms;
  options: WarehouseOptions;
  onDone: () => void;
  /** light = na kartici, dark = u tamnoj traci pri dnu */
  tone?: 'light' | 'dark';
  /** Grupni način: nudi i grupnu izmjenu i otpis. */
  bulk?: boolean;
}) {
  const [which, setWhich] = useState<Which>(null);
  if (!targets.length) return null;
  const ids = targets.map((t) => t.id);
  const all = (states: StateKind[]) => targets.every((t) => states.includes(t.state));
  const none = (states: StateKind[]) => targets.every((t) => !states.includes(t.state));
  const meta = { count: ids.length, onContract: targets.filter((t) => t.onContract).length, cost: sumCost(targets) };
  const base = { open: true, onClose: () => setWhich(null), itemIds: ids, onDone };
  const btn = tone === 'dark' ? 'border-0 bg-white/10 text-white hover:bg-white/20' : '';
  const n = ids.length > 1 ? ` (${ids.length})` : '';

  return (
    <>
      {perms.canOps && all(['IN_STOCK']) && (
        <Button className="border-0 bg-warn-soft text-warn hover:brightness-95" icon={<LogOut className="size-4" />} onClick={() => setWhich('out')}>
          Izašlo iz skladišta{n}
        </Button>
      )}
      {perms.canOps && all(['RESERVED']) && (
        <ActionButton
          className={btn}
          icon={<Undo2 className="size-4" />}
          action={cancelOutAction}
          input={{ itemIds: ids }}
          confirm={`Vratiti ${ids.length} kom na skladište? Izlaz se poništava.`}
          confirmLabel="Vrati na skladište"
          onSuccess={onDone}
        >
          Vrati na skladište{n}
        </ActionButton>
      )}
      {perms.canOps && all(RETURNABLE_STATES) && (
        <Button className={btn} icon={<Undo className="size-4" />} onClick={() => setWhich('return')}>
          Najavi povrat{n}
        </Button>
      )}
      {perms.canOps && all(['RETURNING']) && (
        <Button variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => setWhich('receive')}>
          Zaprimi povrat{n}
        </Button>
      )}
      {perms.canEdit && all(MOVABLE_STATES) && (
        <Button className={btn} icon={<ArrowRightLeft className="size-4" />} onClick={() => setWhich('transfer')}>
          Premjesti u skladište
        </Button>
      )}
      {perms.canOps && (
        <Button className={btn} icon={<Tag className="size-4" />} onClick={() => setWhich('status')}>
          Promijeni status
        </Button>
      )}
      {bulk && perms.canEdit && (
        <Button className={btn} icon={<Pencil className="size-4" />} onClick={() => setWhich('edit')}>
          Uredi
        </Button>
      )}
      {bulk && perms.canEdit && none(NO_WRITE_OFF_STATES) && (
        <Button className="border-0 bg-bad-soft text-bad-strong hover:brightness-95" icon={<Trash2 className="size-4" />} onClick={() => setWhich('writeoff')}>
          Otpiši
        </Button>
      )}
      <Link prefetch={false} href={labelsHref(ids)} className={buttonClass('secondary', 'md', cn(btn, tone === 'dark' && 'border-0'))}>
        <Printer className="size-4" />
        Naljepnic{ids.length > 1 ? 'e' : 'a'}
      </Link>

      {which === 'status' && <StatusDialog {...base} statuses={options.statuses} warehouses={options.warehouses} perms={perms} meta={meta} />}
      {which === 'out' && <MarkOutDialog {...base} count={ids.length} />}
      {which === 'return' && <AnnounceReturnDialog {...base} count={ids.length} />}
      {which === 'transfer' && <TransferDialog {...base} warehouses={options.warehouses} count={ids.length} />}
      {which === 'receive' && <ReceiveReturnDialog {...base} warehouses={options.warehouses} />}
      {which === 'edit' && <BulkEditDialog {...base} warehouses={options.warehouses} models={options.models} count={ids.length} />}
      {which === 'writeoff' && <WriteOffDialog {...base} meta={meta} />}
    </>
  );
}

/** Zaprimanje uređaja u dolasku na odabrano skladište. */
function ReceiveReturnDialog({ onClose, onDone, itemIds, warehouses }: { open: boolean; onClose: () => void; onDone: () => void; itemIds: string[]; warehouses: Option[] }) {
  const [wh, setWh] = useState(warehouses[0]?.value ?? '');
  const { run, pending, error } = useAction(receiveReturnedAction);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Zaprimanje povrata"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!wh}
            onClick={async () => {
              const r = await run({ itemIds, warehouseId: wh });
              if (r.ok) {
                onClose();
                onDone();
              }
            }}
          >
            Zaprimi ({itemIds.length})
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-base text-fg-2">
        <p>Uređaji ({itemIds.length}) idu na skladište, skidaju se s ugovora i gube vezu na klijenta.</p>
        <Field label="Skladište" required>
          <Select value={wh} onChange={(e) => setWh(e.target.value)} options={warehouses} />
        </Field>
        <FormError error={error} />
      </div>
    </Dialog>
  );
}
