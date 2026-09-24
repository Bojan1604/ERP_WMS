'use client';

import { useState } from 'react';
import { Check, CloudDownload, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { ActionButton, FormError, useAction, type ServerAction } from '@/components/ui/action';
import { useToast } from '@/components/ui/toast';
import { REJECT_REASONS } from '@/domain/einvoice-inbound';

type WithWarning = { warning?: string | null } | undefined;

/** Upozorenje iz akcije (npr. posrednik nije primio status) kao crvena poruka. */
function useWarningToast() {
  const toast = useToast();
  return (d: unknown) => {
    const w = (d as WithWarning)?.warning;
    if (w) toast('bad', w);
  };
}

/** „Preuzmi eRačune" — dohvat primljenih računa od posrednika. */
export function FetchEInvoicesButton({ action }: { action: ServerAction<Record<string, never>, unknown> }) {
  const onSuccess = useWarningToast();
  const { run, pending } = useAction(action, { onSuccess });
  return (
    <Button loading={pending} icon={<CloudDownload className="size-4" />} onClick={() => run({})}>
      {pending ? 'Preuzimam…' : 'Preuzmi eRačune'}
    </Button>
  );
}

/**
 * Odluka kupca na stranici ulaznog računa: prihvati, odbij (s razlogom) i
 * „plaćeno danas". eRačun se javlja posredniku; ručni račun samo u programu.
 */
export function SupplierInvoiceDecision({
  id,
  eInvoice,
  canAccept,
  canReject,
  canPay,
  accept,
  reject,
  paidToday,
}: {
  id: string;
  eInvoice: boolean;
  canAccept: boolean;
  canReject: boolean;
  canPay: boolean;
  accept: ServerAction<{ id: string }, unknown>;
  reject: ServerAction<{ id: string; reason: string }, unknown>;
  paidToday: ServerAction<{ id: string }, unknown>;
}) {
  const onSuccess = useWarningToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const rej = useAction(reject);
  const trimmed = reason.trim();

  return (
    <>
      {canAccept && (
        <ActionButton
          action={accept}
          input={{ id }}
          variant="primary"
          icon={<Check className="size-4" />}
          confirmTitle="Prihvatiti račun?"
          confirm={
            eInvoice
              ? 'Prihvaćanje se javlja posredniku (poslovni status „prihvaćen"), a račun se knjiži kao trošak.'
              : 'Račun se označava prihvaćenim i knjiži kao trošak.'
          }
          confirmLabel="Prihvati"
        >
          Prihvati
        </ActionButton>
      )}
      {canReject && (
        <Button variant="danger" icon={<X className="size-4" />} onClick={() => setOpen(true)}>
          Odbij
        </Button>
      )}
      {canPay && (
        <ActionButton
          action={paidToday}
          input={{ id }}
          icon={<Wallet className="size-4" />}
          onSuccess={onSuccess}
          title={eInvoice ? 'Upisuje današnji datum plaćanja i javlja posredniku status „plaćen"' : 'Upisuje današnji datum plaćanja'}
        >
          Označi plaćeno
        </ActionButton>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Odbijanje ulaznog računa"
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="danger"
              loading={rej.pending}
              disabled={trimmed.length < 3}
              onClick={async () => {
                const r = await rej.run({ id, reason: trimmed });
                if (r.ok) {
                  setOpen(false);
                  setReason('');
                }
              }}
            >
              Odbij račun
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {eInvoice ? (
            <Notice tone="warn">
              Odbijanje se javlja <strong>dobavljaču</strong> (preko informacijskog posrednika) i <strong>Poreznoj upravi</strong> (eIzvještavanje). Ne
              može se poništiti. Račun se u programu označava odbijenim tek kad posrednik potvrdi.
            </Notice>
          ) : (
            <Notice tone="info">Ručno upisan račun — odbijanje se bilježi samo u programu, nikome se ne javlja.</Notice>
          )}
          <div className="flex flex-wrap gap-1.5">
            {REJECT_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className="rounded-full bg-muted px-2.5 py-1 text-sm text-fg-2 hover:bg-bad-soft hover:text-bad-strong"
              >
                {r}
              </button>
            ))}
          </div>
          <Field label="Razlog odbijanja" required hint="Dobavljač vidi ovaj tekst.">
            <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Npr. iznos ne odgovara narudžbi…" />
          </Field>
          <FormError error={rej.error} />
        </div>
      </Dialog>
    </>
  );
}
