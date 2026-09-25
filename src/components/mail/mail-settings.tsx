'use client';

import { useState } from 'react';
import { RotateCcw, Send } from 'lucide-react';
import { FormError, useAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { Card, Notice } from '@/components/ui/misc';
import { MAIL_DEFAULTS, MAIL_TEMPLATE_KINDS, MAIL_TEMPLATE_LABEL, MAIL_VARIABLES, type MailTemplates } from '@/domain/mail';
import { saveMailSettingsAction, saveMailTemplatesAction, sendTestEmailAction } from '@/app/(app)/postavke/posta/actions';

export interface MailSettingsValue {
  smtpHost: string;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string;
  /** Lozinka se nikad ne šalje u preglednik — samo je li postavljena. */
  hasPassword: boolean;
  mailFrom: string;
  mailReplyTo: string;
  mailBccSelf: boolean;
  /** E-adresa firme (zadani pošiljatelj). */
  companyEmail: string;
}

const PRESETS = [
  { value: '', label: 'Odaberite za brzo popunjavanje…' },
  { value: 'smtp.gmail.com|587|0', label: 'Gmail / Google Workspace (587, STARTTLS)' },
  { value: 'smtp.office365.com|587|0', label: 'Microsoft 365 / Outlook (587, STARTTLS)' },
  { value: 'smtp.zoho.eu|465|1', label: 'Zoho (465, TLS)' },
];

/** SMTP poslužitelj, prijava, pošiljatelj i skrivena kopija. */
export function MailSettingsForm({ value, canEdit }: { value: MailSettingsValue; canEdit: boolean }) {
  const [v, setV] = useState({ ...value, password: '', clearPassword: false });
  const { run, pending, error, fields } = useAction(saveMailSettingsAction, { onSuccess: () => setV((x) => ({ ...x, password: '', clearPassword: false })) });
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((x) => ({ ...x, [k]: val }));
  return (
    <Card title="SMTP poslužitelj">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run({
            smtpHost: v.smtpHost,
            smtpPort: v.smtpPort,
            smtpSecure: v.smtpSecure,
            smtpUser: v.smtpUser,
            password: v.password || null,
            clearPassword: v.clearPassword,
            mailFrom: v.mailFrom,
            mailReplyTo: v.mailReplyTo,
            mailBccSelf: v.mailBccSelf,
          });
        }}
      >
        {canEdit && (
          <Field label="Poznati poslužitelji">
            <Select
              value=""
              options={PRESETS}
              onChange={(e) => {
                const [host, port, secure] = e.target.value.split('|');
                if (host) setV((x) => ({ ...x, smtpHost: host, smtpPort: Number(port), smtpSecure: secure === '1' }));
              }}
            />
          </Field>
        )}
        <FormGrid cols={3}>
          <Field label="Poslužitelj (host)" error={fields.smtpHost} className="sm:col-span-2">
            <Input value={v.smtpHost} disabled={!canEdit} placeholder="smtp.vasafirma.hr" onChange={(e) => set('smtpHost', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Port" error={fields.smtpPort} hint={v.smtpSecure ? 'Obično 465' : 'Obično 587'}>
            <Input
              type="number"
              inputMode="numeric"
              value={v.smtpPort ?? ''}
              disabled={!canEdit}
              onChange={(e) => set('smtpPort', e.target.value ? Number(e.target.value) : null)}
            />
          </Field>
        </FormGrid>
        <Field label="Šifriranje veze">
          <Select
            value={v.smtpSecure ? '1' : '0'}
            disabled={!canEdit}
            onChange={(e) => set('smtpSecure', e.target.value === '1')}
            options={[
              { value: '0', label: 'STARTTLS (port 587 ili 25)' },
              { value: '1', label: 'TLS od početka (port 465)' },
            ]}
          />
        </Field>
        <FormGrid>
          <Field label="Korisničko ime" error={fields.smtpUser}>
            <Input value={v.smtpUser} disabled={!canEdit} onChange={(e) => set('smtpUser', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Lozinka" error={fields.password} hint={value.hasPassword ? 'Lozinka je postavljena — prazno polje je ne mijenja.' : 'Sprema se šifrirana (AES-256-GCM) i nikad se ne prikazuje.'}>
            <Input
              type="password"
              value={v.password}
              disabled={!canEdit}
              placeholder={value.hasPassword ? '•••••••• (postavljena)' : ''}
              onChange={(e) => set('password', e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Pošiljatelj (From)" error={fields.mailFrom} hint={value.companyEmail ? `Prazno = e-adresa firme (${value.companyEmail})` : 'Adresa s koje poruke odlaze'}>
            <Input type="email" value={v.mailFrom} disabled={!canEdit} placeholder={value.companyEmail || 'racuni@vasafirma.hr'} onChange={(e) => set('mailFrom', e.target.value)} />
          </Field>
          <Field label="Odgovor na (Reply-To)" error={fields.mailReplyTo} hint="Neobavezno — kamo stižu odgovori kupaca">
            <Input type="email" value={v.mailReplyTo} disabled={!canEdit} onChange={(e) => set('mailReplyTo', e.target.value)} />
          </Field>
        </FormGrid>
        <Checkbox label="Skrivena kopija svake poslane poruke na adresu pošiljatelja (BCC)" checked={v.mailBccSelf} disabled={!canEdit} onChange={(e) => set('mailBccSelf', e.target.checked)} />
        {value.hasPassword && canEdit && (
          <Checkbox label="Ukloni spremljenu lozinku" checked={v.clearPassword} onChange={(e) => set('clearPassword', e.target.checked)} className="ml-4" />
        )}
        <FormError error={error} />
        {canEdit && (
          <Button type="submit" variant="primary" loading={pending}>
            Spremi postavke
          </Button>
        )}
      </form>
    </Card>
  );
}

/** Probna poruka — provjera postavki. */
export function MailTestCard({ configured, defaultTo }: { configured: boolean; defaultTo: string }) {
  const [to, setTo] = useState(defaultTo);
  const { run, pending, error, fields } = useAction(sendTestEmailAction);
  return (
    <Card title="Probna poruka">
      {!configured && <Notice tone="info">Upišite i spremite SMTP poslužitelj i pošiljatelja, pa pošaljite probnu poruku.</Notice>}
      <form
        className="mt-2 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run({ to });
        }}
      >
        <Field label="Pošalji na" error={fields.to}>
          <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <FormError error={error} />
        <Button type="submit" loading={pending} disabled={!configured} icon={<Send className="size-4" />}>
          Pošalji probnu poruku
        </Button>
      </form>
    </Card>
  );
}

/** Predlošci naslova i teksta po vrsti poruke, s varijablama. */
export function MailTemplatesForm({ value, canEdit }: { value: MailTemplates; canEdit: boolean }) {
  const [v, setV] = useState<MailTemplates>(value);
  const { run, pending, error } = useAction(saveMailTemplatesAction);
  const set = (k: keyof MailTemplates, f: 'subject' | 'body', val: string) => setV((x) => ({ ...x, [k]: { ...x[k], [f]: val } }));
  return (
    <Card
      title="Predlošci poruka"
      actions={
        canEdit ? (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setV(structuredClone(MAIL_DEFAULTS))}>
            Vrati zadane tekstove
          </Button>
        ) : null
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          run(v);
        }}
      >
        <p className="text-sm text-fg-3">
          Tekst u vitičastim zagradama zamjenjuje se podacima dokumenta, npr. <span className="font-mono">{'{broj}'}</span>,{' '}
          <span className="font-mono">{'{kupac}'}</span>, <span className="font-mono">{'{iznos}'}</span>, <span className="font-mono">{'{dospijece}'}</span>,{' '}
          <span className="font-mono">{'{firma}'}</span>. Prazno polje = zadani tekst.
        </p>
        {MAIL_TEMPLATE_KINDS.map((k) => (
          <fieldset key={k} className="space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
            <legend className="float-left mb-1 w-full text-sm font-semibold text-fg">
              {MAIL_TEMPLATE_LABEL[k]}
              <span className="ml-2 font-mono text-xs font-normal text-fg-3">{MAIL_VARIABLES[k].map((x) => `{${x}}`).join(' ')}</span>
            </legend>
            <Field label="Naslov">
              <Input value={v[k].subject} disabled={!canEdit} onChange={(e) => set(k, 'subject', e.target.value)} />
            </Field>
            <Field label="Tekst">
              <Textarea rows={6} value={v[k].body} disabled={!canEdit} onChange={(e) => set(k, 'body', e.target.value)} />
            </Field>
          </fieldset>
        ))}
        <FormError error={error} />
        {canEdit && (
          <Button type="submit" variant="primary" loading={pending}>
            Spremi predloške
          </Button>
        )}
      </form>
    </Card>
  );
}
