'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { CalendarClock, FilePlus2, FileSignature, PackageCheck, Receipt, Undo2 } from 'lucide-react';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Button, buttonClass } from '@/components/ui/button';
import { ActionButton, useAction, FormError } from '@/components/ui/action';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, type Option } from '@/components/ui/field';
import { SelectionBar } from '@/components/ui/selection';
import { activeContractsAction, addOutToContractAction, cancelOutAction, receiveReturnedAction } from '@/app/(app)/skladiste/izlaz/actions';
import { announceReturnAction } from '@/app/(app)/skladiste/actions';
import { countLabel } from '@/domain/plural';

const barBtn = 'border-0 bg-white/10 text-white hover:bg-white/20';

/** Izašlo iz skladišta: vraćanje na stanje ili prijelaz u prodaju / najam. */
export function ReservedBar({ partnerId, canOps, canSell, canRent }: { partnerId: string | null; canOps: boolean; canSell: boolean; canRent: boolean }) {
  return (
    <SelectionBar>
      {(ids, clear) => {
        const qs = `items=${ids.join(',')}${partnerId ? `&partner=${partnerId}` : ''}`;
        return (
          <>
            {canSell && (
              <Link prefetch={false} href={`/prodaja/racuni/novi?${qs}`} className={buttonClass('primary', 'sm')}>
                <Receipt className="size-3.5" />
                Izdaj račun
              </Link>
            )}
            {canSell && (
              <Link prefetch={false} href={`/prodaja/racuni/novi?${qs}&vrsta=najam`} className={buttonClass('secondary', 'sm', barBtn)} title="Račun za najam s označenim uređajima">
                <CalendarClock className="size-3.5" />
                Račun za najam
              </Link>
            )}
            {canRent && <ToContractButton ids={ids} partnerId={partnerId} onDone={clear} />}
            {canRent && (
              <Link prefetch={false} href={`/najam/ugovori/novi?${qs}`} className={buttonClass('secondary', 'sm', barBtn)}>
                <FilePlus2 className="size-3.5" />
                Novi ugovor
              </Link>
            )}
            {canOps && (
              <ActionButton
                size="sm"
                className={barBtn}
                icon={<Undo2 className="size-3.5" />}
                action={cancelOutAction}
                input={{ itemIds: ids }}
                confirm={`Vratiti ${ids.length} kom na skladište? Izlaz se poništava.`}
                confirmLabel="Vrati na skladište"
                onSuccess={clear}
              >
                Vrati na skladište
              </ActionButton>
            )}
          </>
        );
      }}
    </SelectionBar>
  );
}

/** „Na postojeći ugovor": odabir aktivnog ugovora (zadano ugovori kupca izlaza) i dodavanje uređaja. */
function ToContractButton({ ids, partnerId, onDone }: { ids: string[]; partnerId: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [contractId, setContractId] = useState<string | null>(null);
  const { run, pending, error } = useAction(addOutToContractAction);
  const onSearch = useCallback(async (q: string): Promise<ComboOption[]> => {
    const r = await activeContractsAction({ q, partnerId });
    return r.ok ? (r.data ?? []) : [];
  }, [partnerId]);
  return (
    <>
      <Button size="sm" className={barBtn} icon={<FileSignature className="size-3.5" />} onClick={() => setOpen(true)}>
        Na postojeći ugovor
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Dodati ${countLabel(ids.length, 'uređaj', 'uređaja', 'uređaja')} na ugovor`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!contractId}
              onClick={async () => {
                const r = await run({ contractId, itemIds: ids });
                if (r.ok) {
                  setOpen(false);
                  onDone();
                }
              }}
            >
              Dodaj na ugovor
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-base text-fg-2">
          <p>
            Uređaji ulaze na odabrani aktivni ugovor s predloženom cijenom najma (cjenik kupca, cijena uređaja ili modela), dobivaju status „U najmu" i klijenta s
            ugovora. Cijenu i plan naplate po potrebi dotjerajte na ugovoru.
          </p>
          <Field label="Aktivni ugovor" required hint={partnerId ? 'Prikazani su ugovori kupca izlaza — upišite broj ili naziv za druge.' : 'Upišite broj ugovora ili naziv klijenta.'}>
            <Combobox options={[]} value={contractId} onChange={setContractId} onSearch={onSearch} placeholder="Odaberite ugovor…" />
          </Field>
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}

/** Za povrat / ručni povrat: najava povrata (→ U dolasku). */
export function AnnounceBar() {
  return (
    <SelectionBar>
      {(ids, clear) => (
        <ActionButton
          size="sm"
          variant="primary"
          icon={<Undo2 className="size-3.5" />}
          action={announceReturnAction}
          input={{ itemIds: ids, note: null }}
          confirm={`Najaviti povrat za ${ids.length} kom? Uređaji prelaze u status „U dolasku" i ostaju na ugovoru dok ih ne zaprimite.`}
          confirmLabel="Najavi povrat"
          onSuccess={clear}
        >
          Najavi povrat
        </ActionButton>
      )}
    </SelectionBar>
  );
}

/** U dolasku: zaprimanje na odabrano skladište. */
export function ReturningBar({ warehouses }: { warehouses: Option[] }) {
  const [open, setOpen] = useState(false);
  const [wh, setWh] = useState(warehouses[0]?.value ?? '');
  const { run, pending, error } = useAction(receiveReturnedAction);
  return (
    <SelectionBar>
      {(ids, clear) => (
        <>
          <Button size="sm" variant="primary" icon={<PackageCheck className="size-3.5" />} onClick={() => setOpen(true)}>
            Zaprimi na skladište
          </Button>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Zaprimanje povrata"
            size="sm"
            footer={
              <>
                <Button onClick={() => setOpen(false)}>Odustani</Button>
                <Button
                  variant="primary"
                  loading={pending}
                  disabled={!wh}
                  onClick={async () => {
                    const r = await run({ itemIds: ids, warehouseId: wh });
                    if (r.ok) {
                      setOpen(false);
                      clear();
                    }
                  }}
                >
                  Zaprimi ({ids.length})
                </Button>
              </>
            }
          >
            <div className="space-y-3 text-base text-fg-2">
              <p>
                Uređaji ({ids.length}) idu na skladište, skidaju se s ugovora i gube vezu na klijenta. Povijest ostaje na kartici uređaja.
              </p>
              <Field label="Skladište" required>
                <Select value={wh} onChange={(e) => setWh(e.target.value)} options={warehouses} />
              </Field>
              <FormError error={error} />
            </div>
          </Dialog>
        </>
      )}
    </SelectionBar>
  );
}
