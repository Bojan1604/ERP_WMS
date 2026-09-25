'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ActionForm, ActionButton, FormError, type ServerAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { Card } from '@/components/ui/misc';
import { customerVat, isValidOib, VAT_OVERRIDES, VAT_OVERRIDE_LABEL } from '@/domain/tax';
import { COUNTRIES } from './countries';
import { OibLookupButton, OibLookupResult } from './oib-lookup';
import type { PartnerLookup } from '@/server/lookup';

export interface PartnerFormValue {
  id?: string;
  name: string;
  oib: string | null;
  vatId: string | null;
  address: string | null;
  zip: string | null;
  city: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  iban: string | null;
  contactPerson: string | null;
  isCustomer: boolean;
  isSupplier: boolean;
  excluded: boolean;
  paymentTermDays: number | null;
  note: string | null;
  /** eRačun (C8) */
  endpointId?: string | null;
  vatCategoryOverride?: string | null;
  branchCode?: string | null;
  branchName?: string | null;
}

export function PartnerForm({
  value,
  company,
  save,
  remove,
  lookup,
  canEdit,
}: {
  value: PartnerFormValue;
  company: { vatRegistered: boolean; vatRate: number; country: string; paymentTermDays: number };
  save: ServerAction<FormData>;
  remove?: ServerAction<{ id: string }>;
  lookup?: ServerAction<{ oib: string | null; vatId: string | null; country: string }, PartnerLookup>;
  canEdit: boolean;
}) {
  const [found, setFound] = useState<PartnerLookup | null>(null);
  const [oib, setOib] = useState(value.oib ?? '');
  const [country, setCountry] = useState(value.country || 'HR');
  const [excluded, setExcluded] = useState(value.excluded);
  const [override, setOverride] = useState(value.vatCategoryOverride ?? '');
  const vat = customerVat({ country, vatCategoryOverride: override || null }, company);
  const oibState = !oib.trim() ? null : isValidOib(oib) ? 'ok' : 'bad';
  const countries = COUNTRIES.some((c) => c.value === country) ? COUNTRIES : [{ value: country, label: country }, ...COUNTRIES];

  return (
    <ActionForm action={save} successMessage="Spremljeno." className="space-y-4">
      {({ pending, error, fields }) => (
        <>
          {value.id && <input type="hidden" name="id" value={value.id} />}
          <div className="grid gap-4 xl:grid-cols-3">
            <Card title="Osnovni podaci" className="xl:col-span-2">
              <fieldset disabled={!canEdit} className="space-y-3">
                <Field label="Naziv" required error={fields.name}>
                  <Input name="name" defaultValue={value.name} autoFocus={!value.id} required />
                </Field>
                <FormGrid cols={3}>
                  <Field
                    label="OIB"
                    error={fields.oib}
                    hint={
                      oibState === 'bad' ? (
                        <span className="inline-flex items-center gap-1 text-warn">
                          <AlertTriangle className="size-3" /> Kontrolna znamenka ne odgovara — provjerite OIB.
                        </span>
                      ) : oibState === 'ok' ? (
                        <span className="inline-flex items-center gap-1 text-ok">
                          <CheckCircle2 className="size-3" /> Ispravan OIB
                        </span>
                      ) : (
                        country === 'HR' ? '11 znamenaka' : 'Za strane partnere nije obavezan'
                      )
                    }
                  >
                    <div className="flex gap-2">
                      <Input name="oib" value={oib} onChange={(e) => setOib(e.target.value)} inputMode="numeric" maxLength={20} />
                      {lookup && canEdit && <OibLookupButton lookup={lookup} oib={oib.trim()} country={country} onFound={setFound} />}
                    </div>
                  </Field>
                  <Field label="PDV ID" hint="npr. HR12345678901, SI12345678" error={fields.vatId}>
                    <Input name="vatId" defaultValue={value.vatId ?? ''} />
                  </Field>
                  <Field label="Kontakt osoba">
                    <Input name="contactPerson" defaultValue={value.contactPerson ?? ''} />
                  </Field>
                </FormGrid>
                <FormGrid cols={3}>
                  <Field label="Adresa" className="sm:col-span-3">
                    <Input name="address" defaultValue={value.address ?? ''} />
                  </Field>
                  <Field label="Poštanski broj">
                    <Input name="zip" defaultValue={value.zip ?? ''} />
                  </Field>
                  <Field label="Mjesto">
                    <Input name="city" defaultValue={value.city ?? ''} />
                  </Field>
                  <Field label="Država" hint={<span>Porezni tretman: <b className="text-fg-2">{vat.label}</b></span>}>
                    <Select name="country" value={country} onChange={(e) => setCountry(e.target.value)} options={countries} />
                  </Field>
                </FormGrid>
                <FormGrid cols={3}>
                  <Field label="E-adresa" error={fields.email}>
                    <Input name="email" type="email" defaultValue={value.email ?? ''} />
                  </Field>
                  <Field label="Telefon">
                    <Input name="phone" defaultValue={value.phone ?? ''} />
                  </Field>
                  <Field label="IBAN">
                    <Input name="iban" defaultValue={value.iban ?? ''} />
                  </Field>
                </FormGrid>
                {found && <OibLookupResult r={found} />}
              </fieldset>
            </Card>

            <div className="space-y-4">
              <Card title="Uloga i naplata">
                <fieldset disabled={!canEdit} className="space-y-3">
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    <Checkbox name="isCustomer" label="Kupac" defaultChecked={value.isCustomer} />
                    <Checkbox name="isSupplier" label="Dobavljač" defaultChecked={value.isSupplier} />
                  </div>
                  <Field label="Rok plaćanja (dana)" hint={`Prazno = zadano iz postavki (${company.paymentTermDays} dana)`} error={fields.paymentTermDays}>
                    <Input name="paymentTermDays" type="number" min={0} max={365} defaultValue={value.paymentTermDays ?? ''} className="w-32" />
                  </Field>
                  <Field label="Napomena na računima" hint="Ističe se pri izdavanju računa ovom partneru.">
                    <Textarea name="note" defaultValue={value.note ?? ''} rows={3} />
                  </Field>
                </fieldset>
              </Card>
              <Card title="eRačun">
                <fieldset disabled={!canEdit} className="space-y-3">
                  <Field label="Elektronička adresa" hint="Oblik „shema:id“ (npr. 9934:OIB, 0088:GLN). Prazno = OIB (shema 9934)." error={fields.endpointId}>
                    <Input name="endpointId" defaultValue={value.endpointId ?? ''} className="font-mono" placeholder="prazno = OIB" />
                  </Field>
                  <Field
                    label="Porezna kategorija"
                    error={fields.vatCategoryOverride}
                    hint="Automatski i za kupce izvan sustava PDV-a (obrt, paušalist) — račun im ide s PDV-om. Ručna kategorija je za posebne slučajeve."
                  >
                    <Select
                      name="vatCategoryOverride"
                      value={override}
                      onChange={(e) => setOverride(e.target.value)}
                      placeholder="Automatski prema državi"
                      options={VAT_OVERRIDES.map((v) => ({ value: v, label: VAT_OVERRIDE_LABEL[v] }))}
                    />
                  </Field>
                  <FormGrid cols={3}>
                    <Field label="Poslovna jedinica" hint="šifra" error={fields.branchCode}>
                      <Input name="branchCode" defaultValue={value.branchCode ?? ''} className="font-mono" maxLength={20} />
                    </Field>
                    <Field label="Naziv jedinice" className="sm:col-span-2" error={fields.branchName}>
                      <Input name="branchName" defaultValue={value.branchName ?? ''} placeholder="npr. Restoran Marina, Split" />
                    </Field>
                  </FormGrid>
                </fieldset>
              </Card>
              <Card title="Obračun">
                <fieldset disabled={!canEdit}>
                  <Checkbox name="excluded" label="Isključen iz obračuna" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} />
                  <p className="mt-2 text-sm text-fg-3">
                    Računi, troškovi i uređaji isključenog partnera ne ulaze u izvještaje, marže ni nadzornu ploču. Podaci ostaju zapisani i
                    vidljivi — ništa se ne briše.
                  </p>
                  {excluded && !value.excluded && <p className="mt-2 rounded-md bg-warn-soft px-2.5 py-1.5 text-sm text-warn">Nakon spremanja partner više neće ulaziti u brojke.</p>}
                </fieldset>
              </Card>
            </div>
          </div>
          <FormError error={error} />
          {canEdit && (
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" loading={pending}>
                {value.id ? 'Spremi promjene' : 'Dodaj partnera'}
              </Button>
              {value.id && remove && (
                <ActionButton
                  action={remove}
                  input={{ id: value.id }}
                  variant="ghost"
                  className="ml-auto text-bad-strong"
                  confirmTitle="Brisanje partnera"
                  confirmLabel="Obriši"
                  confirm="Partner se može obrisati samo ako nema nijedan dokument ni uređaj. Ako ih ima, umjesto brisanja označite ga kao isključenog iz obračuna."
                >
                  Obriši partnera
                </ActionButton>
              )}
            </div>
          )}
        </>
      )}
    </ActionForm>
  );
}
