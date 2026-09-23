'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button, type ButtonProps } from './button';
import { useToast } from './toast';
import { Dialog } from './dialog';

import type { ActionResult } from '@/lib/action-result';

export type { ActionResult };

export type ServerAction<I = unknown, T = unknown> = (input: I) => Promise<ActionResult<T>>;

/**
 * Poziv server akcije iz klijenta: čekanje, poruka o uspjehu/grešci,
 * preusmjeravanje ili osvježavanje prikaza.
 */
export function useAction<I, T>(fn: ServerAction<I, T>, opts: { onSuccess?: (data: T | undefined) => void; successMessage?: string; refresh?: boolean } = {}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const toast = useToast();
  const router = useRouter();

  const run = (input: I) =>
    new Promise<ActionResult<T>>((resolve) => {
      start(async () => {
        const res = await fn(input);
        if (res.ok) {
          setError(null);
          setFields({});
          const msg = res.message ?? opts.successMessage;
          if (msg) toast('ok', msg);
          opts.onSuccess?.(res.data);
          if (res.redirect) router.push(res.redirect);
          else if (opts.refresh !== false) router.refresh();
        } else {
          setError(res.error);
          setFields(res.fields ?? {});
          toast('bad', res.error);
        }
        resolve(res);
      });
    });

  return { run, pending, error, fields };
}

/** Obrazac koji šalje FormData server akciji. */
export function ActionForm({
  action,
  children,
  className,
  onSuccess,
  successMessage = 'Spremljeno.',
  resetOnSuccess,
}: {
  action: ServerAction<FormData>;
  children: ReactNode | ((state: { pending: boolean; error: string | null; fields: Record<string, string> }) => ReactNode);
  className?: string;
  onSuccess?: (data: unknown) => void;
  successMessage?: string;
  resetOnSuccess?: boolean;
}) {
  const { run, pending, error, fields } = useAction(action, { onSuccess, successMessage });
  return (
    <form
      className={className}
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const res = await run(new FormData(form));
        if (res.ok && resetOnSuccess) form.reset();
      }}
    >
      {typeof children === 'function' ? children({ pending, error, fields }) : children}
    </form>
  );
}

/** Gumb koji poziva akciju s unaprijed zadanim ulazom, po želji uz potvrdu. */
export function ActionButton<I>({
  action,
  input,
  confirm,
  confirmTitle = 'Potvrda',
  confirmLabel = 'Potvrdi',
  successMessage,
  onSuccess,
  children,
  ...button
}: Omit<ButtonProps, 'onClick' | 'loading'> & {
  action: ServerAction<I>;
  input: I;
  confirm?: ReactNode;
  confirmTitle?: string;
  confirmLabel?: string;
  successMessage?: string;
  onSuccess?: (data: unknown) => void;
}) {
  const { run, pending } = useAction(action, { successMessage, onSuccess });
  const [ask, setAsk] = useState(false);
  return (
    <>
      <Button {...button} loading={pending} onClick={() => (confirm ? setAsk(true) : run(input))}>
        {children}
      </Button>
      {confirm && (
        <Dialog
          open={ask}
          onClose={() => setAsk(false)}
          title={confirmTitle}
          size="sm"
          footer={
            <>
              <Button onClick={() => setAsk(false)}>Odustani</Button>
              <Button
                variant={button.variant === 'danger' ? 'danger' : 'primary'}
                loading={pending}
                onClick={async () => {
                  const r = await run(input);
                  if (r.ok) setAsk(false);
                }}
              >
                {confirmLabel}
              </Button>
            </>
          }
        >
          <div className="text-base text-fg-2">{confirm}</div>
        </Dialog>
      )}
    </>
  );
}

export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">{error}</p>;
}
