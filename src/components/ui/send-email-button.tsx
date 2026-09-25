'use client';

import { useState, type ReactNode } from 'react';
import { Download, ExternalLink, Mail } from 'lucide-react';
import { Button, buttonClass, type ButtonSize, type ButtonVariant } from './button';
import { Dialog } from './dialog';
import { Checkbox, Field, Input, Textarea } from './field';
import { Notice } from './misc';
import { FormError, useAction } from './action';
import { pdfUrl } from './pdf-button';
import { getEmailDraft, sendDocumentEmail } from '@/server/mail/actions';
import { mailtoHref } from '@/domain/mail';
import type { MailKind, PdfKind } from '@/domain/documents';

const DEFAULT_SUBJECT: Record<MailKind, string> = {
  invoice: 'Račun',
  quote: 'Ponuda',
  proforma: 'Predračun',
  delivery: 'Otpremnica',
  service: 'Servisni nalog',
  partner: '',
  'accountant-zip': 'Dokumenti za knjigovodstvo',
};

interface Draft {
  to: string;
  cc: string;
  subject: string;
  body: string;
  attachPdf: boolean;
}

/**
 * Gumb „Pošalji e-poštom": dijalog s primateljem, kopijom, naslovom, tekstom
 * i „Priloži PDF". Primatelj, naslov i tekst dolaze iz predloška firme
 * (Postavke → E-pošta); izravno zadani `default*` imaju prednost. Bez SMTP-a
 * dijalog nudi preuzimanje PDF-a (ZIP-a) i otvaranje poruke u programu za poštu.
 * Za `accountant-zip` je `id` popis ključeva „out:<id>,in:<id>,…".
 */
export function SendEmailButton({
  kind,
  id,
  defaultTo,
  defaultSubject,
  defaultBody,
  reminder,
  onSent,
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
  /** Opomena: tekst iz predloška „Opomena", iznos = otvoreni iznos računa. */
  reminder?: boolean;
  /** Nakon uspješnog slanja (npr. označi „poslano knjigovođi"). */
  onSent?: () => void;
  label?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [pdf, setPdf] = useState<{ kind: PdfKind; id: string } | null>(null);
  const [zipBusy, setZipBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const base = (): Draft => ({
    to: defaultTo ?? '',
    cc: '',
    subject: defaultSubject ?? DEFAULT_SUBJECT[kind],
    body: defaultBody ?? '',
    attachPdf: kind !== 'partner',
  });
  const [v, setV] = useState<Draft>(base);
  const { run, pending, error, fields } = useAction(sendDocumentEmail, {
    refresh: false,
    onSuccess: () => {
      setOpen(false);
      onSent?.();
    },
  });

  const openDialog = async () => {
    setV(base());
    setLoadError(null);
    setOpen(true);
    setLoading(true);
    const res = await getEmailDraft({ kind, id, reminder });
    setLoading(false);
    if (!res.ok) {
      setLoadError(res.error);
      return;
    }
    const d = res.data!;
    setConfigured(d.configured);
    setPdf(d.pdf);
    setV((x) => ({
      ...x,
      to: defaultTo ?? (x.to || d.to),
      subject: defaultSubject ?? (d.subject || x.subject),
      body: defaultBody ?? (d.body || x.body),
    }));
  };

  const downloadZip = async () => {
    setZipBusy(true);
    try {
      const res = await fetch('/api/knjigovodja/zip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: id.split(',') }) });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'knjigovodja.zip';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      setLoadError(e instanceof Error && e.message ? e.message : 'Arhivu nije moguće preuzeti.');
    } finally {
      setZipBusy(false);
    }
  };

  const hasAttachment = kind !== 'partner';
  const mailto = mailtoHref({ to: v.to, cc: v.cc, subject: v.subject, body: v.body });

  return (
    <>
      <Button variant={variant} size={size} icon={icon ?? <Mail className="size-4" />} onClick={() => void openDialog()}>
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Slanje e-poštom"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            {configured ? (
              <Button
                variant="primary"
                loading={pending}
                disabled={loading}
                icon={<Mail className="size-4" />}
                onClick={() => void run({ kind, id, to: v.to, cc: v.cc || undefined, subject: v.subject, body: v.body, attachPdf: v.attachPdf })}
              >
                Pošalji
              </Button>
            ) : (
              <a
                href={mailto}
                className={buttonClass('primary', 'md')}
                onClick={() => {
                  // bez SMTP-a poruka odlazi iz programa za poštu — privitak se prilaže ručno
                  setTimeout(() => setOpen(false), 300);
                }}
              >
                <ExternalLink className="size-4" /> Otvori u programu za poštu
              </a>
            )}
          </>
        }
      >
        <div className="space-y-3">
          {!configured && (
            <Notice tone="info">
              Slanje iz aplikacije nije podešeno (Postavke → E-pošta).{' '}
              {hasAttachment ? 'Preuzmite privitak, otvorite poruku u svom programu za poštu i priložite ga.' : 'Poruka će se otvoriti u vašem programu za poštu.'}
            </Notice>
          )}
          {!configured && hasAttachment && (
            <div className="flex flex-wrap gap-2">
              {kind === 'accountant-zip' ? (
                <Button size="sm" icon={<Download className="size-3.5" />} loading={zipBusy} onClick={() => void downloadZip()}>
                  Preuzmi ZIP
                </Button>
              ) : pdf ? (
                <a href={pdfUrl(pdf.kind, pdf.id, true)} className={buttonClass('secondary', 'sm')}>
                  <Download className="size-3.5" /> Preuzmi PDF
                </a>
              ) : null}
            </div>
          )}
          <Field label="Prima" required error={fields.to} hint="Više adresa odvojite zarezom.">
            <Input type="text" inputMode="email" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} autoFocus />
          </Field>
          <Field label="Kopija (CC)" error={fields.cc}>
            <Input type="text" inputMode="email" value={v.cc} onChange={(e) => setV({ ...v, cc: e.target.value })} />
          </Field>
          <Field label="Naslov" required error={fields.subject}>
            <Input value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} disabled={loading} />
          </Field>
          <Field label="Poruka" error={fields.body}>
            <Textarea rows={8} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} disabled={loading} placeholder={loading ? 'Učitavanje predloška…' : undefined} />
          </Field>
          {configured && hasAttachment && (
            <Checkbox
              label={kind === 'accountant-zip' ? 'Priloži ZIP s dokumentima' : 'Priloži PDF dokumenta'}
              checked={v.attachPdf}
              onChange={(e) => setV({ ...v, attachPdf: e.target.checked })}
            />
          )}
          <FormError error={loadError ?? error} />
        </div>
      </Dialog>
    </>
  );
}
