'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { FormError, useAction } from '@/components/ui/action';
import { deleteContractAction } from '@/app/(app)/najam/ugovori/actions';

/**
 * Brisanje ugovora (samo bez računa). Uređaji u najmu: ugovor otvoren greškom →
 * natrag na skladište; inače su kod klijenta i idu u povrat („U dolasku").
 */
export function ContractDeleteButton({
  id,
  number,
  rented,
  warehouses,
}: {
  id: string;
  number: string;
  /** Broj uređaja u najmu na ugovoru. */
  rented: number;
  warehouses: { value: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<'stock' | 'returning'>('stock');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const del = useAction(deleteContractAction, { onSuccess: () => setOpen(false) });
  return (
    <>
      <Button variant="ghost" className="text-bad-strong" icon={<Trash2 className="size-4" />} onClick={() => setOpen(true)}>
        Obriši
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Obrisati ugovor ${number}?`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="danger"
              loading={del.pending}
              disabled={rented > 0 && target === 'stock' && !warehouseId}
              onClick={() => del.run({ id, warehouseId: rented > 0 && target === 'stock' ? warehouseId : null })}
            >
              Obriši ugovor
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-base text-fg-2">
          <p>Ugovor se briše zajedno s rasporedom naplate, preskočenim i pauziranim ratama i priloženim PDF-om. Ugovor s računima se ne može obrisati — njega otkažite.</p>
          {rented > 0 ? (
            <>
              <p className="text-sm">Na ugovoru je {rented} uređaja u najmu:</p>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="target" checked={target === 'stock'} onChange={() => setTarget('stock')} className="mt-1" />
                <span>
                  <b>Vrati na skladište</b> — ugovor je otvoren greškom, uređaji nisu otišli klijentu.
                </span>
              </label>
              {target === 'stock' && (
                <Field label="Skladište" className="ml-6">
                  <Select options={warehouses} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} />
                </Field>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="target" checked={target === 'returning'} onChange={() => setTarget('returning')} className="mt-1" />
                <span>
                  <b>Najavi povrat</b> — uređaji su kod klijenta i prelaze u „U dolasku" dok ih skladište ne zaprimi.
                </span>
              </label>
            </>
          ) : null}
          <FormError error={del.error} />
        </div>
      </Dialog>
    </>
  );
}
