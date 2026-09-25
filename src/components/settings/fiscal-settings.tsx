'use client';

import { useState } from 'react';
import { PlugZap, RotateCw, Trash2, Upload } from 'lucide-react';
import { ActionButton, ActionForm, FormError, useAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select } from '@/components/ui/field';
import { Badge, Card, Notice } from '@/components/ui/misc';
import { EINVOICE_PROVIDERS, FISCAL_ENVS, type CertSummary } from '@/domain/fiscal';
import {
  removeFiscalCertAction,
  retryFiscalAction,
  saveFiscalSettingsAction,
  testFiscalConnectionAction,
  uploadFiscalCertAction,
} from '@/app/(app)/postavke/fiskalizacija/actions';
import { FileInput } from '@/components/ui/file-input';

export interface FiscalSettingsValue {
  fiscalEnabled: boolean;
  fiscalEnv: 'TEST' | 'PROD';
  fiscalSequenceMode: 'P' | 'N';
  eInvoiceProvider: 'none' | 'demo' | 'eposlovanje' | 'moj-eracun';
  /** API ključ se nikad ne šalje u preglednik — samo je li postavljen. */
  hasApiKey: boolean;
  hasCert: boolean;
}

/** Uključivanje, okruženje, slijed brojeva i posrednik za eRačun. */
export function FiscalSettingsForm({ value, canEdit }: { value: FiscalSettingsValue; canEdit: boolean }) {
  const [v, setV] = useState({ ...value, apiKey: '', clearApiKey: false });
  const { run, pending, error } = useAction(saveFiscalSettingsAction, { onSuccess: () => setV((x) => ({ ...x, apiKey: '', clearApiKey: false })) });
  const prod = v.fiscalEnv === 'PROD';
  const needsKey = v.eInvoiceProvider === 'eposlovanje' || v.eInvoiceProvider === 'moj-eracun';
  return (
    <Card title="Postavke">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run({
            fiscalEnabled: v.fiscalEnabled,
            fiscalEnv: v.fiscalEnv,
            fiscalSequenceMode: v.fiscalSequenceMode,
            eInvoiceProvider: v.eInvoiceProvider,
            apiKey: v.apiKey || null,
            clearApiKey: v.clearApiKey,
          });
        }}
      >
        <Checkbox
          label="Fiskalizacija uključena (računi za gotovinu, kartice i krajnje kupce idu u CIS)"
          checked={v.fiscalEnabled}
          disabled={!canEdit}
          onChange={(e) => setV({ ...v, fiscalEnabled: e.target.checked })}
        />
        <FormGrid>
          <Field label="Okruženje">
            <Select value={v.fiscalEnv} disabled={!canEdit} onChange={(e) => setV({ ...v, fiscalEnv: e.target.value as 'TEST' | 'PROD' })} options={FISCAL_ENVS} />
          </Field>
          <Field label="Slijednost rednih brojeva (OznSlijed)">
            <Select
              value={v.fiscalSequenceMode}
              disabled={!canEdit}
              onChange={(e) => setV({ ...v, fiscalSequenceMode: e.target.value as 'P' | 'N' })}
              options={[
                { value: 'P', label: 'P — na razini poslovnog prostora' },
                { value: 'N', label: 'N — na razini naplatnog uređaja' },
              ]}
            />
          </Field>
          <Field label="Posrednik za eRačun (Fiskalizacija 2.0)">
            <Select
              value={v.eInvoiceProvider}
              disabled={!canEdit}
              onChange={(e) => setV({ ...v, eInvoiceProvider: e.target.value as FiscalSettingsValue['eInvoiceProvider'] })}
              options={EINVOICE_PROVIDERS}
            />
          </Field>
          <Field
            label="API ključ posrednika"
            hint={value.hasApiKey ? 'Ključ je postavljen — prazno polje ga ne mijenja.' : needsKey ? 'Ključ iz korisničkog profila kod posrednika.' : 'Nije potreban za demo.'}
          >
            <Input
              type="password"
              value={v.apiKey}
              disabled={!canEdit}
              placeholder={value.hasApiKey ? '•••••••• (postavljen)' : ''}
              onChange={(e) => setV({ ...v, apiKey: e.target.value })}
              autoComplete="off"
            />
          </Field>
        </FormGrid>
        {value.hasApiKey && canEdit && (
          <Checkbox label="Ukloni spremljeni API ključ" checked={v.clearApiKey} onChange={(e) => setV({ ...v, clearApiKey: e.target.checked })} />
        )}
        {prod && v.fiscalEnabled && <Notice tone="bad">Produkcija: računi se stvarno prijavljuju Poreznoj upravi.</Notice>}
        {!prod && v.fiscalEnabled && !value.hasCert && (
          <Notice tone="info">Demo način: bez certifikata ZKI se računa demo ključem, a JIR je izmišljen (ne šalje se u CIS). Na računu je jasno označen u dnevniku.</Notice>
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

/** Učitavanje FINA .p12 certifikata. */
export function CertCard({ cert, warnings, canEdit }: { cert: CertSummary | null; warnings: string[]; canEdit: boolean }) {
  return (
    <Card
      title="Certifikat"
      actions={cert ? <Badge tone={warnings.length ? 'warn' : 'ok'}>učitan</Badge> : <Badge tone="neutral">nije učitan</Badge>}
    >
      {cert && (
        <dl className="mb-3 space-y-1 text-sm">
          <Row k="Subjekt" v={cert.subject} />
          <Row k="Izdavatelj" v={cert.issuer} />
          <Row k="OIB" v={cert.oib ?? '—'} />
          <Row k="Vrijedi do" v={new Date(cert.validTo).toLocaleDateString('hr-HR')} />
        </dl>
      )}
      {warnings.map((w) => (
        <p key={w} className="mb-2 rounded-md bg-warn-soft px-2.5 py-1.5 text-sm text-warn">
          {w}
        </p>
      ))}
      {canEdit && (
        <ActionForm action={uploadFiscalCertAction} successMessage="Certifikat je učitan." resetOnSuccess>
          {({ pending, error }) => (
            <div className="space-y-2">
              <Field label={cert ? 'Zamijeni certifikat (.p12 / .pfx)' : 'Datoteka certifikata (.p12 / .pfx)'}>
                <FileInput name="file" accept=".p12,.pfx,application/x-pkcs12" required buttonLabel="Odaberi certifikat" />
              </Field>
              <Field label="Lozinka certifikata" hint="Sprema se šifrirana (AES-256-GCM) i nikad se ne prikazuje.">
                <Input type="password" name="password" required autoComplete="off" />
              </Field>
              <FormError error={error} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" size="sm" loading={pending} icon={<Upload className="size-3.5" />}>
                  Učitaj i provjeri
                </Button>
                {cert && (
                  <ActionButton
                    action={removeFiscalCertAction}
                    input={{}}
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 className="size-3.5" />}
                    confirm="Ukloniti certifikat? Bez njega se u produkciji ne mogu izdavati računi koji se fiskaliziraju."
                    confirmLabel="Ukloni"
                  >
                    Ukloni
                  </ActionButton>
                )}
              </div>
            </div>
          )}
        </ActionForm>
      )}
    </Card>
  );
}

/** Provjera veze i naknadna fiskalizacija. */
export function FiscalTools({ pending }: { pending: number }) {
  return (
    <div className="flex flex-wrap gap-2">
      <ActionButton action={testFiscalConnectionAction} input={{}} icon={<PlugZap className="size-4" />}>
        Testiraj vezu
      </ActionButton>
      <ActionButton
        action={retryFiscalAction}
        input={{}}
        variant={pending ? 'primary' : 'secondary'}
        icon={<RotateCw className="size-4" />}
        confirm={`Ponovno poslati račune koji čekaju ili su pali (${pending}, najviše 50 odjednom)?`}
        confirmLabel="Pošalji"
      >
        Naknadna fiskalizacija{pending ? ` (${pending})` : ''}
      </ActionButton>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-fg-3">{k}</dt>
      <dd className="min-w-0 break-words text-right">{v}</dd>
    </div>
  );
}
