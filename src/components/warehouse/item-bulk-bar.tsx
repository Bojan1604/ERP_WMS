'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRightLeft, Eraser, LogOut, Pencil, Printer, Tag, Trash2, Undo2 } from 'lucide-react';
import { Button, buttonClass } from '@/components/ui/button';
import { labelsHref } from './scan-actions';
import { SelectionBar } from '@/components/ui/selection';
import {
  AnnounceReturnDialog, BulkEditDialog, MarkOutDialog, StatusDialog, TransferDialog, WriteOffDialog,
  type Perms, type SelectedMeta, type WarehouseOptions,
} from './dialogs';
import { DeleteItemsDialog } from './item-delete';
import { MOVABLE_STATES, NO_WRITE_OFF_STATES, RETURNABLE_STATES, type StateKind } from '@/domain/warehouse';

export interface RowMeta {
  state: StateKind;
  onContract: boolean;
  cost: number;
}

type Which = 'status' | 'out' | 'transfer' | 'writeoff' | 'edit' | 'return' | 'delete' | null;

const barBtn = 'border-0 bg-white/10 text-white hover:bg-white/20';

/** Traka radnji za označene uređaje u popisu skladišta. */
export function ItemBulkBar({ rows, options, perms }: { rows: Record<string, RowMeta>; options: WarehouseOptions; perms: Perms }) {
  const [which, setWhich] = useState<Which>(null);
  return (
    // na mobitelu traka stoji pri dnu (iznad donje navigacije), jedan red koji se povlači vodoravno
    <div className="max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[calc(5.25rem+env(safe-area-inset-bottom))] max-sm:z-30 max-sm:[&>div]:mb-0 max-sm:[&>div]:flex-nowrap max-sm:[&>div]:overflow-x-auto max-sm:[&>div>*]:shrink-0">
      <SelectionBar>
        {(ids, clear) => {
          const sel = ids.map((id) => rows[id]).filter(Boolean);
          const meta: SelectedMeta = {
            count: ids.length,
            onContract: sel.filter((r) => r.onContract).length,
            cost: sel.reduce((s, r) => s + r.cost, 0),
          };
          const all = (states: StateKind[]) => sel.length > 0 && sel.every((r) => states.includes(r.state));
          const none = (states: StateKind[]) => sel.every((r) => !states.includes(r.state));
          const close = () => setWhich(null);
          const base = { open: true, onClose: close, itemIds: ids, onDone: clear };
          return (
            <>
              <Button size="sm" className={barBtn} icon={<Tag className="size-3.5" />} onClick={() => setWhich('status')}>
                Promijeni status
              </Button>
              {perms.canOps && (
                <Button
                  size="sm"
                  className="border-0 bg-warn-soft text-warn hover:brightness-95"
                  icon={<LogOut className="size-3.5" />}
                  disabled={!all(['IN_STOCK'])}
                  title={all(['IN_STOCK']) ? undefined : 'Samo uređaji na skladištu'}
                  onClick={() => setWhich('out')}
                >
                  Izašlo iz skladišta
                </Button>
              )}
              {perms.canOps && all(RETURNABLE_STATES) && (
                <Button size="sm" className={barBtn} icon={<Undo2 className="size-3.5" />} onClick={() => setWhich('return')}>
                  Najavi povrat
                </Button>
              )}
              {perms.canEdit && (
                <>
                  <Button
                    size="sm"
                    className={barBtn}
                    icon={<ArrowRightLeft className="size-3.5" />}
                    disabled={!all(MOVABLE_STATES)}
                    title={all(MOVABLE_STATES) ? undefined : 'Premjestiti se mogu samo uređaji na skladištu, izašli, na servisu ili ostali'}
                    onClick={() => setWhich('transfer')}
                  >
                    Premjesti
                  </Button>
                  <Button size="sm" className={barBtn} icon={<Pencil className="size-3.5" />} onClick={() => setWhich('edit')}>
                    Uredi
                  </Button>
                  <Button
                    size="sm"
                    className="border-0 bg-bad-soft text-bad-strong hover:brightness-95"
                    icon={<Trash2 className="size-3.5" />}
                    disabled={!none(NO_WRITE_OFF_STATES)}
                    title={none(NO_WRITE_OFF_STATES) ? undefined : 'Prodani i otpisani uređaji ne mogu se otpisati'}
                    onClick={() => setWhich('writeoff')}
                  >
                    Otpiši
                  </Button>
                  <Button
                    size="sm"
                    className="border-0 bg-bad-soft text-bad-strong hover:brightness-95"
                    icon={<Eraser className="size-3.5" />}
                    title="Trajno obriši uređaje bez računa, ugovora i međuskladišnice"
                    onClick={() => setWhich('delete')}
                  >
                    Obriši
                  </Button>
                </>
              )}
              {which === 'status' && <StatusDialog {...base} statuses={options.statuses} warehouses={options.warehouses} perms={perms} meta={meta} />}
              {which === 'out' && <MarkOutDialog {...base} count={ids.length} />}
              {which === 'return' && <AnnounceReturnDialog {...base} count={ids.length} />}
              {which === 'transfer' && <TransferDialog {...base} warehouses={options.warehouses} count={ids.length} />}
              {which === 'edit' && <BulkEditDialog {...base} warehouses={options.warehouses} models={options.models} count={ids.length} canSeeCost={perms.canSeeCost !== false} />}
              {which === 'delete' && <DeleteItemsDialog {...base} />}
              <Link prefetch={false} href={labelsHref(ids)} className={buttonClass('secondary', 'sm', barBtn)}>
                <Printer className="size-3.5" />
                Ispiši naljepnice
              </Link>
              {which === 'writeoff' && <WriteOffDialog {...base} meta={meta} />}
            </>
          );
        }}
      </SelectionBar>
    </div>
  );
}
