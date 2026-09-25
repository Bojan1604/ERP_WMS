'use client';

import { useState } from 'react';
import { Check, CloudDownload, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { ActionButton, FormError, useAction, type ServerAction } from '@/components/ui/action';
import { useToast } from '@/components/ui/toast';
import { REJECT_REASONS } from '@/domain/einvoice-inbound';
import { acceptBookDefault, type AcceptBookPreview } from '@/domain/purchase-links';
import { eur } from '@/lib/format';

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
  recentReceipts,
  bookPreview = null,
  canReject,
  canPay,
  accept,
  reject,
  paidToday,
}: {
  id: string;
  eInvoice: boolean;
  canAccept: boolean;
  /** Broj primki istog dobavljača u 90 dana prije računa — tada je roba vjerojatno već knjižena primkom. */
  recentReceipts: number;
  /** Što bi prihvaćanje knjižilo po pravilu troška robe (povezani račun) — `null` za nepovezani. */
  bookPreview?: AcceptBookPreview | null;
  canReject: boolean;
  canPay: boolean;
  accept: ServerAction<{ id: string; book: boolean }, unknown>;
  reject: ServerAction<{ id: string; reason: string }, unknown>;
  paidToday: ServerAction<{ id: string }, unknown>;
}) {
  const onSuccess = useWarningToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const rej = useAction(reject);
  const trimmed = reason.trim();
  const [accepting, setAccepting] = useState(false);
  // povezani račun za robu knjiži samo razliku iznad primki (pravilo max(primke, računi)); nepovezani uz nedavne primke — isključeno
  const bookDefault = acceptBookDefault(recentReceipts, bookPreview, (v) => eur(v));
  const [book, setBook] = useState(bookDefault.book);
  const acc = useAction(accept);

  return (
    <>
      {canAccept && (
        <Button variant="primary" icon={<Check className="size-4" />} onClick={() => setAccepting(true)}>
          Prihvati
        </Button>
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
        open={accepting}
        onClose={() => setAccepting(false)}
        title="Prihvatiti račun?"
        size="sm"
        footer={
          <>
            <Button onClick={() => setAccepting(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={acc.pending}
              onClick={async () => {
                const r = await acc.run({ id, book });
                if (r.ok) setAccepting(false);
              }}
            >
              Prihvati
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-base text-fg-2">
            {eInvoice ? 'Prihvaćanje se javlja posredniku (poslovni status „prihvaćen").' : 'Račun se označava prihvaćenim.'}
          </p>
          <div>
            <Checkbox label="Knjiži kao trošak" checked={book} onChange={(e) => setBook(e.target.checked)} />
            <p className="mt-1 text-xs text-fg-3">{bookDefault.hint}</p>
          </div>
          <FormError error={acc.error} />
        </div>
      </Dialog>

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
