'use client';

import { useState } from 'react';
import { ClipboardCheck, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, type Option } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { FormError, useAction } from '@/components/ui/action';
import { integer } from '@/lib/format';
import { closeStocktakeAction, createStocktakeAction } from '@/app/(app)/skladiste/inventura/actions';

/** „Nova inventura": skladište (ili sva) i napomena. */
export function NewStocktakeButton({ warehouses }: { warehouses: Option[] }) {
  const [open, setOpen] = useState(false);
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const [note, setNote] = useState('');
  const { run, pending, error } = useAction(createStocktakeAction);
  return (
    <>
      <Button variant="primary" icon={<ClipboardCheck className="size-4" />} onClick={() => setOpen(true)}>
        Nova inventura
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Nova inventura"
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button variant="primary" loading={pending} onClick={() => run({ warehouseId, note })}>
              Započni
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Skladište" hint="Očekuju se svi uređaji na stanju u odabranom skladištu. Više ljudi može skenirati istu inventuru.">
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} options={[...warehouses, { value: '', label: 'Sva skladišta' }]} />
          </Field>
          <Field label="Napomena">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="npr. godišnja inventura, polica A" />
          </Field>
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}

/**
 * Zatvaranje inventure: sažetak se sprema, a po želji se uređaji iz drugog
 * skladišta premjeste ovamo i nedostajućima postavi status ili ih se otpiše.
 */
export function CloseStocktakeButton({
  id,
  number,
  hasWarehouse,
  counts,
  wrongWarehouse,
  statuses,
  canEdit,
}: {
  id: string;
  number: string;
  hasWarehouse: boolean;
  counts: { expected: number; found: number; missing: number; extra: number };
  wrongWarehouse: number;
  statuses: Option[];
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [move, setMove] = useState(false);
  const [missingAction, setMissingAction] = useState<'none' | 'status' | 'writeOff'>('none');
  const [statusId, setStatusId] = useState('');
  const [book, setBook] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const { run, pending, error } = useAction(closeStocktakeAction);
  const changes = missingAction !== 'none' && counts.missing > 0;
  const ready = (!changes || confirmed) && (missingAction !== 'status' || !!statusId);
  return (
    <>
      <Button variant="primary" icon={<Lock className="size-4" />} onClick={() => setOpen(true)}>
        Zatvori inventuru
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Zatvaranje inventure ${number}`}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant={changes ? 'danger' : 'primary'}
              loading={pending}
              disabled={!ready}
              onClick={async () => {
                const r = await run({ id, moveWrongWarehouse: move, missingAction, missingStatusId: statusId, bookExpense: book });
                if (r.ok) setOpen(false);
              }}
            >
              Zatvori inventuru
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-base">
          <p className="text-fg-2">
            Očekivano <b>{integer(counts.expected)}</b>, pronađeno <b>{integer(counts.found)}</b>, nedostaje <b>{integer(counts.missing)}</b>, višak{' '}
            <b>{integer(counts.extra)}</b>. Nakon zatvaranja skeniranje više nije moguće, a izvještaj ostaje kakav je bio u trenutku zatvaranja.
          </p>
          {!canEdit && (counts.missing > 0 || wrongWarehouse > 0) && (
            <Notice tone="info">Premještaj i promjena statusa uređaja traže razinu „Uređivanje" — inventuru možete zatvoriti samo sa sažetkom.</Notice>
          )}
          {canEdit && hasWarehouse && wrongWarehouse > 0 && (
            <Checkbox
              checked={move}
              onChange={(e) => setMove(e.target.checked)}
              label={<>Premjesti {integer(wrongWarehouse)} uređaja pronađenih ovdje, a vođenih u drugom skladištu, u ovo skladište (međuskladišnica)</>}
            />
          )}
          {canEdit && counts.missing > 0 && (
            <fieldset className="space-y-2 rounded-lg border border-line p-3">
              <legend className="px-1 text-sm font-medium text-fg-2">Uređaji koji nedostaju ({integer(counts.missing)})</legend>
              {(
                [
                  ['none', 'Ne mijenjaj — samo zabilježi u izvještaju'],
                  ['status', 'Postavi status'],
                  ['writeOff', 'Otpiši kao izgubljene'],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className="flex items-center gap-2">
                  <input type="radio" name="missing" checked={missingAction === v} onChange={() => setMissingAction(v)} className="size-4 accent-[var(--color-brand)]" />
                  {label}
                </label>
              ))}
              {missingAction === 'status' && (
                <Field label="Status" hint={statuses.length ? undefined : 'Dodajte status vrste „Ostalo" (npr. „Nedostaje") u Postavke → Šifrarnici.'}>
                  <Select value={statusId} onChange={(e) => setStatusId(e.target.value)} placeholder="Odaberite status…" options={statuses} />
                </Field>
              )}
              {missingAction === 'writeOff' && (
                <Checkbox checked={book} onChange={(e) => setBook(e.target.checked)} label={<>Knjiži trošak „Otpis opreme" u iznosu nabavne vrijednosti</>} />
              )}
              {changes && (
                <Checkbox
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="font-medium text-bad-strong"
                  label={<>Potvrđujem promjenu za {integer(counts.missing)} uređaja koji nisu pronađeni</>}
                />
              )}
            </fieldset>
          )}
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}
