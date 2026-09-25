'use client';

import { useState } from 'react';
import { Check, PackageCheck, X } from 'lucide-react';
import { Button, LinkButton } from '@/components/ui/button';
import { ActionButton, useAction, FormError } from '@/components/ui/action';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea, type Option } from '@/components/ui/field';
import { ackRequestAction, approveReceiveAction, resolveApprovalAction } from '@/app/(app)/skladiste/odobrenja/actions';
import { countLabel, plural } from '@/domain/plural';

export function ApprovalButtons({ id, count, onContract, target, targetKind }: { id: string; count: number; onContract: number; target: string; targetKind: string }) {
  const detaches = targetKind !== 'RENTED' && targetKind !== 'RETURNING' ? onContract : 0;
  return (
    <>
      <ActionButton
        variant="primary"
        icon={<Check className="size-4" />}
        action={resolveApprovalAction}
        input={{ id, approve: true, note: null }}
        confirm={
          <>
            Promijeniti status za {count} kom u „{target}“?
            {detaches > 0 && <span className="mt-2 block text-warn">{countLabel(detaches, 'uređaj', 'uređaja', 'uređaja')} {plural(detaches, 'je', 'su', 'je')} na ugovoru — bit će {plural(detaches, 'skinut', 'skinuta', 'skinuto')} s ugovora.</span>}
          </>
        }
        confirmLabel="Odobri"
      >
        Odobri
      </ActionButton>
      <RejectButton id={id} />
    </>
  );
}

/** Odbijanje zahtjeva s obaveznim razlogom (podnositelj ga vidi). */
export function RejectButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const { run, pending, error } = useAction(resolveApprovalAction);
  return (
    <>
      <Button icon={<X className="size-4" />} onClick={() => setOpen(true)}>
        Odbij
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Odbijanje zahtjeva"
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="danger"
              loading={pending}
              disabled={!note.trim()}
              onClick={async () => {
                const r = await run({ id, approve: false, note });
                if (r.ok) setOpen(false);
              }}
            >
              Odbij zahtjev
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Razlog odbijanja" required hint="Podnositelj zahtjeva vidi razlog na skeniranju i na ovoj stranici.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus />
          </Field>
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}

/**
 * Zahtjev za zaprimanje: s novim serijskim brojevima → obrazac zaprimanja
 * (model, cijena, primka); samo s poznatim uređajima → povrat na skladište.
 */
export function ReceiveApprovalButtons({ id, serials, returning, warehouseId, warehouses }: { id: string; serials: number; returning: number; warehouseId: string | null; warehouses: Option[] }) {
  const [open, setOpen] = useState(false);
  const [wh, setWh] = useState(warehouseId && warehouses.some((w) => w.value === warehouseId) ? warehouseId : (warehouses[0]?.value ?? ''));
  const { run, pending, error } = useAction(approveReceiveAction);
  return (
    <>
      {serials > 0 ? (
        <LinkButton href={`/skladiste/odobrenja/${id}`} variant="primary" icon={<PackageCheck className="size-4" />}>
          Provjeri i zaprimi
        </LinkButton>
      ) : (
        <Button variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => setOpen(true)}>
          Vrati na skladište
        </Button>
      )}
      <RejectButton id={id} />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Povrat na skladište"
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!wh}
              onClick={async () => {
                const r = await run({ id, warehouseId: wh });
                if (r.ok) setOpen(false);
              }}
            >
              Odobri ({returning})
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-base text-fg-2">
          <p>Uređaji ({returning}) idu na skladište, skidaju se s ugovora i gube vezu na klijenta. Slike naljepnica prelaze na kartice uređaja.</p>
          <Field label="Skladište" required>
            <Select value={wh} onChange={(e) => setWh(e.target.value)} options={warehouses} />
          </Field>
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}

/** Podnositelj potvrđuje da je vidio odbijanje. */
export function AckButton({ id, size = 'sm' }: { id: string; size?: 'sm' | 'md' }) {
  return (
    <ActionButton size={size} action={ackRequestAction} input={{ id }} icon={<Check className="size-3.5" />}>
      U redu
    </ActionButton>
  );
}
