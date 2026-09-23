'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActionButton, useAction, FormError } from '@/components/ui/action';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { resolveApprovalAction } from '@/app/(app)/skladiste/odobrenja/actions';

export function ApprovalButtons({ id, count, onContract, target, targetKind }: { id: string; count: number; onContract: number; target: string; targetKind: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const { run, pending, error } = useAction(resolveApprovalAction);
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
            {detaches > 0 && <span className="mt-2 block text-warn">{detaches} uređaja je na ugovoru — bit će skinuto s ugovora.</span>}
          </>
        }
        confirmLabel="Odobri"
      >
        Odobri
      </ActionButton>
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
          <Field label="Razlog odbijanja" required hint="Podnositelj zahtjeva vidi razlog na ovoj stranici.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus />
          </Field>
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}
