'use client';

import { useState, type ReactNode } from 'react';
import { Mail } from 'lucide-react';
import { Button, type ButtonSize, type ButtonVariant } from './button';
import { Dialog } from './dialog';
import { Checkbox, Field, Input, Textarea } from './field';
import { FormError, useAction } from './action';
import { sendDocumentEmail } from '@/server/mail/actions';
import type { MailKind } from '@/domain/documents';

const DEFAULT_SUBJECT: Record<MailKind, string> = {
  invoice: 'Račun',
  quote: 'Ponuda',
  proforma: 'Predračun',
  delivery: 'Otpremnica',
  service: 'Servisni nalog',
  partner: '',
  'accountant-zip': 'Dokumenti za knjigovodstvo',
};

/**
 * Gumb „Pošalji e-poštom": dijalog s primateljem, kopijom, naslovom, tekstom
 * i „Priloži PDF", poziva server akciju `sendDocumentEmail`. Područje A dodaje
 * predloške (naslov/tekst iz postavki) — potpis komponente ostaje.
 */
export function SendEmailButton({
  kind,
  id,
  defaultTo,
  defaultSubject,
  defaultBody,
  label = 'Pošalji',
  variant = 'secondary',
  size = 'md',
  icon,
}: {
  kind: MailKind;
  id: string;
  defaultTo?: string | null;
  defaultSubject?: string;
  defaultBody?: string;
  label?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const initial = () => ({
    to: defaultTo ?? '',
    cc: '',
    subject: defaultSubject ?? DEFAULT_SUBJECT[kind],
    body: defaultBody ?? '',
    attachPdf: kind !== 'partner',
  });
  const [v, setV] = useState(initial);
  const { run, pending, error, fields } = useAction(sendDocumentEmail, { refresh: false, onSuccess: () => setOpen(false) });
  return (
    <>
      <Button
        variant={variant}
        size={size}
        icon={icon ?? <Mail className="size-4" />}
        onClick={() => {
          setV(initial());
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Slanje e-poštom"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              icon={<Mail className="size-4" />}
              onClick={() => void run({ kind, id, to: v.to, cc: v.cc || undefined, subject: v.subject, body: v.body, attachPdf: v.attachPdf })}
            >
              Pošalji
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Prima" required error={fields.to} hint="Više adresa odvojite zarezom.">
            <Input type="text" inputMode="email" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} autoFocus />
          </Field>
          <Field label="Kopija (CC)" error={fields.cc}>
            <Input type="text" inputMode="email" value={v.cc} onChange={(e) => setV({ ...v, cc: e.target.value })} />
          </Field>
          <Field label="Naslov" required error={fields.subject}>
            <Input value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} />
          </Field>
          <Field label="Poruka" error={fields.body}>
            <Textarea rows={8} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} />
          </Field>
          {kind !== 'partner' && (
            <Checkbox
              label={kind === 'accountant-zip' ? 'Priloži ZIP s dokumentima' : 'Priloži PDF dokumenta'}
              checked={v.attachPdf}
              onChange={(e) => setV({ ...v, attachPdf: e.target.checked })}
            />
          )}
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}
