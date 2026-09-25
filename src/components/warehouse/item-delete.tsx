'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FormError, useAction } from '@/components/ui/action';
import { deleteItemsAction } from '@/app/(app)/skladiste/actions';

/**
 * Brisanje uređaja: dopušteno samo bez računa, ugovora, međuskladišnice i
 * servisnog naloga — poslužitelj vraća popis uređaja koji se ne mogu obrisati.
 */
export function DeleteItemsDialog({ itemIds, open, onClose, onDone, back }: { itemIds: string[]; open: boolean; onClose: () => void; onDone?: () => void; back?: boolean }) {
  const { run, pending, error } = useAction(deleteItemsAction);
  const n = itemIds.length;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={n === 1 ? 'Brisanje uređaja' : `Brisanje ${n} uređaja`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button
            variant="danger"
            loading={pending}
            onClick={async () => {
              const r = await run({ itemIds, back: !!back });
              if (r.ok) {
                onClose();
                onDone?.();
              }
            }}
          >
            Obriši {n === 1 ? 'uređaj' : `(${n})`}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-base text-fg-2">
        <p>{n === 1 ? 'Uređaj se trajno uklanja' : 'Uređaji se trajno uklanjaju'} iz evidencije zajedno s poviješću i prilozima.</p>
        <p className="text-sm text-fg-3">
          Brišu se samo uređaji koji nisu na računu, ugovoru, međuskladišnici ni servisnom nalogu — takve otpišite. Primka i trošak nabave ostaju; za
          povrat robe dobavljaču stornirajte primku.
        </p>
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

/** Gumb „Obriši" na kartici uređaja. */
export function DeleteItemButton({ itemId }: { itemId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" icon={<Trash2 className="size-4" />} className="text-bad-strong" onClick={() => setOpen(true)}>
        Obriši
      </Button>
      {open && <DeleteItemsDialog open itemIds={[itemId]} onClose={() => setOpen(false)} back />}
    </>
  );
}
