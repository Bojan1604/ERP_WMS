'use client';

import { useState } from 'react';
import { Play } from 'lucide-react';
import { ActionButton, ActionForm, FormError, type ServerAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select } from '@/components/ui/field';
import { Card } from '@/components/ui/misc';
import { EXEMPT_DEFAULTS } from '@/domain/tax';
import { isValidOib } from '@/domain/tax';

export interface CompanyDocsValue {
  swift: string | null;
  proformaTitle: string;
  eInvoicePaymentMeans: string;
  paymentModel: string;
  operatorName: string | null;
  operatorOib: string | null;
  vatTextEuGoods: string | null;
  vatTextEuService: string | null;
  vatTextThirdGoods: string | null;
  vatTextThirdService: string | null;
  legalFooter: string | null;
  autoIssueRent: boolean;
  vatOnPayment: boolean;
  kpdRent: string | null;
  kpdSale: string | null;
  kpdService: string | null;
  eInvoiceAttachPdf: boolean;
  eReportingEnabled: boolean;
}

const EXEMPT_FIELDS = [
  ['vatTextEuGoods', 'Prodaja kupcu u EU', EXEMPT_DEFAULTS.euGoods],
  ['vatTextEuService', 'Najam / usluga kupcu u EU', EXEMPT_DEFAULTS.euService],
  ['vatTextThirdGoods', 'Prodaja u treću zemlju', EXEMPT_DEFAULTS.thirdGoods],
  ['vatTextThirdService', 'Najam / usluga u treću zemlju', EXEMPT_DEFAULTS.thirdService],
] as const;

/** Postavke firme za dokumente, porez, eRačun, KPD i najam (F9). */
export function CompanyDocsForm({
  value,
  save,
  canEdit,
  runAutoIssue,
  canRunAutoIssue,
}: {
  value: CompanyDocsValue;
  save: ServerAction<FormData>;
  canEdit: boolean;
  runAutoIssue: ServerAction<Record<string, never>>;
  canRunAutoIssue: boolean;
}) {
  const [oib, setOib] = useState(value.operatorOib ?? '');
  return (
    <ActionForm action={save} successMessage="Postavke dokumenata spremljene.">
      {({ pending, error, fields }) => (
        <fieldset disabled={!canEdit} className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-3">
            <Card title="Dokumenti i plaćanje">
              <div className="space-y-3">
                <FormGrid>
                  <Field label="SWIFT / BIC banke" hint="Uz IBAN na računu (strani kupci)" error={fields.swift}>
                    <Input name="swift" defaultValue={value.swift ?? ''} placeholder="npr. PBZGHR2X" className="font-mono uppercase" />
                  </Field>
                  <Field label="Naslov predračuna" error={fields.proformaTitle}>
                    <Input name="proformaTitle" defaultValue={value.proformaTitle} list="proforma-naslovi" />
                    <datalist id="proforma-naslovi">
                      <option value="Predračun" />
                      <option value="Proforma" />
                      <option value="Profaktura" />
                      <option value="Proforma račun" />
                    </datalist>
                  </Field>
                  <Field label="Način plaćanja na eRačunu" error={fields.eInvoicePaymentMeans}>
                    <Select
                      name="eInvoicePaymentMeans"
                      defaultValue={value.eInvoicePaymentMeans}
                      options={[
                        { value: '30', label: '30 — kreditni transfer' },
                        { value: '58', label: '58 — SEPA kreditni transfer' },
                      ]}
                    />
                  </Field>
                  <Field label="Model poziva na broj" hint="HUB3 i eRačun" error={fields.paymentModel}>
                    <Input name="paymentModel" defaultValue={value.paymentModel} maxLength={4} className="font-mono uppercase" />
                  </Field>
                </FormGrid>
                <p className="text-xs text-fg-3">Operater na računu je korisnik koji ga izdaje (ime i OIB u Postavke → Korisnici). Zadani operater vrijedi kad korisnik nema OIB.</p>
                <FormGrid>
                  <Field label="Zadani operater — ime" error={fields.operatorName}>
                    <Input name="operatorName" defaultValue={value.operatorName ?? ''} />
                  </Field>
                  <Field label="Zadani operater — OIB" error={fields.operatorOib} hint={oib && !isValidOib(oib) ? <span className="text-warn">Kontrolna znamenka ne odgovara.</span> : undefined}>
                    <Input name="operatorOib" value={oib} onChange={(e) => setOib(e.target.value.replace(/\s/g, ''))} inputMode="numeric" maxLength={11} />
                  </Field>
                </FormGrid>
              </div>
            </Card>

            <Card title="Tekstovi oslobođenja PDV-a (strani kupci)" className="xl:col-span-2">
              <div className="space-y-2">
                {EXEMPT_FIELDS.map(([k, label, def]) => (
                  <div key={k} className="grid gap-1 sm:grid-cols-[13rem_1fr] sm:items-center">
                    <span className="text-sm text-fg-2">{label}</span>
                    <Input name={k} defaultValue={value[k] ?? ''} placeholder={def} />
                  </div>
                ))}
                <p className="text-xs text-fg-3">Prazno = zadani tekst (u polju). Na miješanom računu (prodaja + najam) svaka stavka dobiva tekst svoje vrste.</p>
                <Field label="Pravni podaci u podnožju svih dokumenata" error={fields.legalFooter} className="pt-1">
                  <Input name="legalFooter" defaultValue={value.legalFooter ?? ''} placeholder="npr. Temeljni kapital 2.654,46 € uplaćen u cijelosti · Trgovački sud u Splitu MBS 060345725" />
                </Field>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card title="Porez i eRačun">
              <div className="space-y-2.5">
                <Checkbox name="vatOnPayment" defaultChecked={value.vatOnPayment} label="Obračun PDV-a prema naplaćenim naknadama" />
                <Checkbox name="eInvoiceAttachPdf" defaultChecked={value.eInvoiceAttachPdf} label="Uz poslani eRačun priloži PDF računa" />
                <Checkbox name="eReportingEnabled" defaultChecked={value.eReportingEnabled} label="Uplate na eRačune prijavljuj u eIzvještavanje" />
              </div>
            </Card>
            <Card title="Zadane KPD šifre">
              <FormGrid cols={3}>
                <Field label="Najam" error={fields.kpdRent}>
                  <Input name="kpdRent" defaultValue={value.kpdRent ?? ''} placeholder="77.39.19" className="font-mono" />
                </Field>
                <Field label="Prodaja" error={fields.kpdSale}>
                  <Input name="kpdSale" defaultValue={value.kpdSale ?? ''} placeholder="26.20.13" className="font-mono" />
                </Field>
                <Field label="Usluga" error={fields.kpdService}>
                  <Input name="kpdService" defaultValue={value.kpdService ?? ''} placeholder="95.11.10" className="font-mono" />
                </Field>
              </FormGrid>
              <p className="mt-2 text-xs text-fg-3">Primjenjuju se na nove stavke kad KPD nije zadan na modelu ili usluzi.</p>
            </Card>
            <Card title="Rate najma">
              <Checkbox name="autoIssueRent" defaultChecked={value.autoIssueRent} label="Automatski izdaj račune za rate najma na dan dospijeća" />
              <p className="mt-2 text-xs text-fg-3">
                Poslužitelj jednom dnevno (od 6 h) izdaje rate dospjele od dana uključivanja i fiskalizira ih; starije neizdane rate izdajete ručno (Najam → Za izdati). Svaki račun i greška upisuju se u dnevnik promjena.
              </p>
              {canRunAutoIssue && (
                <div className="mt-3">
                  <ActionButton
                    action={runAutoIssue}
                    input={{}}
                    size="sm"
                    icon={<Play className="size-3.5" />}
                    confirm="Izdati sada račune za rate najma ove firme dospjele od uključivanja automatskog izdavanja?"
                    confirmLabel="Izdaj"
                  >
                    Pokreni sada
                  </ActionButton>
                </div>
              )}
            </Card>
          </div>

          <FormError error={error} />
          {canEdit && (
            <Button type="submit" variant="primary" loading={pending}>
              Spremi postavke dokumenata
            </Button>
          )}
        </fieldset>
      )}
    </ActionForm>
  );
}
