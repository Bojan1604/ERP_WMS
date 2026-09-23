'use client';

import { useRef, useState } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import { ActionForm, FormError, type ServerAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { Card } from '@/components/ui/misc';
import { formatInvoiceNumber } from '@/domain/invoice';
import { isValidOib } from '@/domain/tax';
import { COUNTRIES } from '@/components/partners/countries';

export interface CompanyValue {
  name: string;
  oib: string | null;
  vatId: string | null;
  address: string | null;
  zip: string | null;
  city: string | null;
  country: string;
  iban: string | null;
  bank: string | null;
  email: string | null;
  phone: string | null;
  web: string | null;
  logo: string | null;
  currency: string;
  vatRegistered: boolean;
  vatRate: number;
  overdueDays: number;
  paymentTermDays: number;
  quoteValidDays: number;
  defaultMarginPct: number;
  defaultWarrantyMonths: number;
  rentFallbackPct: number;
  invoicePremises: string;
  invoiceDevice: string;
  invoiceSeparator: string;
  invoiceFooter: string | null;
  statusChangeNeedsApproval: boolean;
}

const MAX_LOGO = 300 * 1024;
const CURRENCIES = [
  { value: 'EUR', label: 'EUR — euro' },
  { value: 'RSD', label: 'RSD — srpski dinar' },
  { value: 'BAM', label: 'BAM — konvertibilna marka' },
  { value: 'CHF', label: 'CHF — švicarski franak' },
  { value: 'USD', label: 'USD — američki dolar' },
];
const dec = (v: number) => String(v).replace('.', ',');

export function CompanyForm({ value, save, canEdit }: { value: CompanyValue; save: ServerAction<FormData>; canEdit: boolean }) {
  const [logo, setLogo] = useState<string | null>(value.logo);
  const [logoChanged, setLogoChanged] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [vatRegistered, setVatRegistered] = useState(value.vatRegistered);
  const [num, setNum] = useState({ premises: value.invoicePremises, device: value.invoiceDevice, sep: value.invoiceSeparator });
  const [oib, setOib] = useState(value.oib ?? '');
  const file = useRef<HTMLInputElement>(null);

  const pickLogo = (f: File | undefined) => {
    setLogoError(null);
    if (!f) return;
    if (!f.type.startsWith('image/')) return setLogoError('Odaberite sliku (PNG, JPG, SVG…).');
    if (f.size > MAX_LOGO) return setLogoError(`Slika ima ${Math.round(f.size / 1024)} KB — najviše je 300 KB.`);
    const r = new FileReader();
    r.onload = () => {
      setLogo(String(r.result));
      setLogoChanged(true);
    };
    r.readAsDataURL(f);
  };

  return (
    <ActionForm action={save} successMessage="Postavke spremljene." onSuccess={() => setLogoChanged(false)}>
      {({ pending, error, fields }) => (
        <fieldset disabled={!canEdit} className="space-y-4">
          <input type="hidden" name="logo" value={logoChanged ? (logo ?? '') : 'keep'} />
          <div className="grid gap-4 xl:grid-cols-3">
            <Card title="Podaci firme" className="xl:col-span-2">
              <div className="space-y-3">
                <Field label="Naziv" required error={fields.name}>
                  <Input name="name" defaultValue={value.name} required />
                </Field>
                <FormGrid cols={3}>
                  <Field label="OIB" hint={oib && !isValidOib(oib) ? <span className="text-warn">Kontrolna znamenka ne odgovara.</span> : undefined}>
                    <Input name="oib" value={oib} onChange={(e) => setOib(e.target.value)} inputMode="numeric" />
                  </Field>
                  <Field label="PDV ID">
                    <Input name="vatId" defaultValue={value.vatId ?? ''} />
                  </Field>
                  <Field label="Država">
                    <Select name="country" defaultValue={value.country} options={COUNTRIES} />
                  </Field>
                  <Field label="Adresa" className="sm:col-span-3">
                    <Input name="address" defaultValue={value.address ?? ''} />
                  </Field>
                  <Field label="Poštanski broj">
                    <Input name="zip" defaultValue={value.zip ?? ''} />
                  </Field>
                  <Field label="Mjesto" className="sm:col-span-2">
                    <Input name="city" defaultValue={value.city ?? ''} />
                  </Field>
                  <Field label="IBAN" className="sm:col-span-2">
                    <Input name="iban" defaultValue={value.iban ?? ''} />
                  </Field>
                  <Field label="Banka">
                    <Input name="bank" defaultValue={value.bank ?? ''} />
                  </Field>
                  <Field label="E-adresa">
                    <Input name="email" type="email" defaultValue={value.email ?? ''} />
                  </Field>
                  <Field label="Telefon">
                    <Input name="phone" defaultValue={value.phone ?? ''} />
                  </Field>
                  <Field label="Web">
                    <Input name="web" defaultValue={value.web ?? ''} />
                  </Field>
                </FormGrid>
              </div>
            </Card>

            <Card title="Logo">
              <div className="flex h-28 items-center justify-center rounded-md border border-dashed border-line-strong bg-white p-3">
                {logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logo} alt="Logo firme" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-sm text-fg-4">Nema loga — na dokumentima piše naziv firme.</span>
                )}
              </div>
              <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => pickLogo(e.target.files?.[0])} />
              <div className="mt-3 flex gap-2">
                <Button icon={<ImageUp className="size-4" />} onClick={() => file.current?.click()}>
                  {logo ? 'Zamijeni' : 'Učitaj sliku'}
                </Button>
                {logo && (
                  <Button
                    variant="ghost"
                    icon={<Trash2 className="size-4" />}
                    onClick={() => {
                      setLogo(null);
                      setLogoChanged(true);
                      if (file.current) file.current.value = '';
                    }}
                  >
                    Ukloni
                  </Button>
                )}
              </div>
              <p className="mt-2 text-xs text-fg-3">PNG, JPG ili SVG do 300 KB. Ispisuje se u zaglavlju računa, ponuda i drugih dokumenata.</p>
              {logoError && <p className="mt-1 text-xs text-bad-strong">{logoError}</p>}
              {logoChanged && <p className="mt-1 text-xs text-warn">Logo će se promijeniti nakon spremanja.</p>}
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card title="Porez i valuta">
              <div className="space-y-3">
                <Checkbox name="vatRegistered" label="U sustavu PDV-a" checked={vatRegistered} onChange={(e) => setVatRegistered(e.target.checked)} />
                <FormGrid>
                  <Field label="Stopa PDV-a (%)" error={fields.vatRate}>
                    <Input name="vatRate" inputMode="decimal" defaultValue={dec(value.vatRate)} disabled={!vatRegistered} className="text-right" />
                  </Field>
                  <Field label="Valuta">
                    <Select name="currency" defaultValue={value.currency} options={CURRENCIES.some((c) => c.value === value.currency) ? CURRENCIES : [{ value: value.currency, label: value.currency }, ...CURRENCIES]} />
                  </Field>
                </FormGrid>
                {!vatRegistered && <p className="text-xs text-fg-3">Računi se izdaju bez PDV-a uz napomenu o čl. 90. Zakona o PDV-u.</p>}
                {!vatRegistered && <input type="hidden" name="vatRate" value={dec(value.vatRate)} />}
              </div>
            </Card>

            <Card title="Rokovi">
              <FormGrid>
                <Field label="Rok plaćanja (dana)" hint="Zadano za nove račune" error={fields.paymentTermDays}>
                  <Input name="paymentTermDays" type="number" min={0} defaultValue={value.paymentTermDays} />
                </Field>
                <Field label="Kašnjenje nakon (dana)" hint="Za račune bez roka plaćanja" error={fields.overdueDays}>
                  <Input name="overdueDays" type="number" min={0} defaultValue={value.overdueDays} />
                </Field>
                <Field label="Valjanost ponude (dana)" error={fields.quoteValidDays}>
                  <Input name="quoteValidDays" type="number" min={0} defaultValue={value.quoteValidDays} />
                </Field>
                <Field label="Jamstvo (mjeseci)" hint="Zadano za prodane uređaje" error={fields.defaultWarrantyMonths}>
                  <Input name="defaultWarrantyMonths" type="number" min={0} defaultValue={value.defaultWarrantyMonths} />
                </Field>
              </FormGrid>
            </Card>

            <Card title="Cijene">
              <FormGrid>
                <Field label="Bruto marža (%)" hint="Prodajna = nabavna ÷ (1 − marža)" error={fields.defaultMarginPct}>
                  <Input name="defaultMarginPct" inputMode="decimal" defaultValue={dec(value.defaultMarginPct)} className="text-right" />
                </Field>
                <Field label="Najam, % nabavne" hint="Prijedlog mjesečnog najma kad model nema cijenu" error={fields.rentFallbackPct}>
                  <Input name="rentFallbackPct" inputMode="decimal" defaultValue={dec(value.rentFallbackPct)} className="text-right" />
                </Field>
              </FormGrid>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card title="Numeracija računa">
              <FormGrid cols={3}>
                <Field label="Poslovni prostor" error={fields.invoicePremises}>
                  <Input name="invoicePremises" value={num.premises} onChange={(e) => setNum({ ...num, premises: e.target.value })} />
                </Field>
                <Field label="Naplatni uređaj" error={fields.invoiceDevice}>
                  <Input name="invoiceDevice" value={num.device} onChange={(e) => setNum({ ...num, device: e.target.value })} />
                </Field>
                <Field label="Razdjelnik" error={fields.invoiceSeparator}>
                  <Input name="invoiceSeparator" value={num.sep} maxLength={3} onChange={(e) => setNum({ ...num, sep: e.target.value })} />
                </Field>
              </FormGrid>
              <p className="mt-3 text-sm text-fg-3">
                Primjer: <b className="font-mono text-fg">{formatInvoiceNumber(12, num.premises || '?', num.device || '?', num.sep || '/')}</b>
                <span className="ml-1">— redni broj kreće od 1 svake godine.</span>
              </p>
            </Card>
            <Card title="Podnožje dokumenata" className="xl:col-span-2">
              <Field hint="Ispisuje se na dnu računa i ponuda (npr. upis u registar, temeljni kapital, uprava).">
                <Textarea name="invoiceFooter" defaultValue={value.invoiceFooter ?? ''} rows={3} />
              </Field>
              <Checkbox
                className="mt-3"
                name="statusChangeNeedsApproval"
                defaultChecked={value.statusChangeNeedsApproval}
                label="Promjena statusa uređaja uz operativno pravo ide na odobrenje"
              />
            </Card>
          </div>

          <FormError error={error} />
          {canEdit && (
            <Button type="submit" variant="primary" loading={pending}>
              Spremi postavke
            </Button>
          )}
        </fieldset>
      )}
    </ActionForm>
  );
}
