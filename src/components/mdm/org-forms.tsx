'use client';

import { useState } from 'react';
import { KeyRound, Pencil, Plus } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { PartnerCombobox } from '@/components/partners/partner-combobox';
import type { PartnerOpt } from '@/lib/partner-option';
import { useAction } from '@/components/ui/action';
import { LEVEL_LABEL } from '@/domain/permissions';
import { resetMdmPasswordAction, saveMdmUserAction, saveOrgAction, saveSiteAction } from '@/app/(app)/mdm/organizacije/actions';

function useDialog() {
  const [open, setOpen] = useState(false);
  return { open, show: () => setOpen(true), close: () => setOpen(false) };
}

export type { OrgValue } from './common';
import type { OrgValue } from './common';


/**
 * Nova organizacija ili izmjena. Vlasnik bira vrstu i distributera te vezu na
 * ERP partnera; distributer otvara samo svoje klijente (poslužitelj to i provjerava).
 */
export function OrgDialog({
  value,
  label,
  owner,
  distributors = [],
  partner = null,
  lockActive,
  variant,
  size,
}: {
  value: OrgValue;
  label: string;
  owner: boolean;
  distributors?: { id: string; name: string }[];
  /** Povezani ERP partner (ostali se traže pretragom na poslužitelju). */
  partner?: PartnerOpt | null;
  lockActive?: boolean;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}) {
  const d = useDialog();
  const [v, setV] = useState(value);
  const { run, pending, fields } = useAction(saveOrgAction, { onSuccess: d.close });
  const set = (patch: Partial<OrgValue>) => setV({ ...v, ...patch });
  const isNew = !value.id;
  return (
    <>
      <Button variant={variant ?? (isNew ? 'primary' : 'secondary')} size={size} icon={isNew ? <Plus className="size-4" /> : <Pencil className="size-4" />} onClick={() => { setV(value); d.show(); }}>
        {label}
      </Button>
      <Dialog
        open={d.open}
        onClose={d.close}
        title={isNew ? (v.type === 'DISTRIBUTOR' ? 'Novi distributer' : 'Novi klijent') : `Organizacija — ${value.name}`}
        footer={
          <>
            <Button onClick={d.close}>Odustani</Button>
            <Button variant="primary" loading={pending} onClick={() => run({ ...v, id: value.id ?? null })}>
              Spremi
            </Button>
          </>
        }
      >
        <FormGrid>
          {isNew && owner && (
            <>
              <Field label="Vrsta">
                <Select value={v.type} onChange={(e) => set({ type: e.target.value as OrgValue['type'], parentId: e.target.value === 'DISTRIBUTOR' ? null : v.parentId })} options={[{ value: 'DISTRIBUTOR', label: 'Distributer' }, { value: 'CUSTOMER', label: 'Klijent' }]} />
              </Field>
              <Field label="Distributer" hint={v.type === 'CUSTOMER' ? 'Prazno = klijent izravno pod vlasnikom.' : undefined}>
                <Select value={v.parentId ?? ''} disabled={v.type === 'DISTRIBUTOR'} onChange={(e) => set({ parentId: e.target.value || null })} placeholder="— izravno —" options={distributors.map((x) => ({ value: x.id, label: x.name }))} />
              </Field>
            </>
          )}
          <Field label="Naziv" required error={fields.name} className="sm:col-span-2">
            <Input value={v.name} onChange={(e) => set({ name: e.target.value })} maxLength={150} autoFocus />
          </Field>
          <Field label="OIB" error={fields.oib}>
            <Input value={v.oib} onChange={(e) => set({ oib: e.target.value.replace(/\D/g, '').slice(0, 11) })} inputMode="numeric" />
          </Field>
          <Field label="E-adresa">
            <Input type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} />
          </Field>
          <Field label="Telefon">
            <Input value={v.phone} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
          <Field label="Grad">
            <Input value={v.city} onChange={(e) => set({ city: e.target.value })} />
          </Field>
          <Field label="Adresa" className="sm:col-span-2">
            <Input value={v.address} onChange={(e) => set({ address: e.target.value })} />
          </Field>
          {owner && (
            <Field label="ERP partner" hint="Veza na partnera u ERP-u (vidi samo vlasnik)." className="sm:col-span-2">
              <PartnerCombobox initial={partner} value={v.partnerId} onChange={(val) => set({ partnerId: val })} placeholder="— bez veze —" allowEmpty />
            </Field>
          )}
          <Field label="Napomena" className="sm:col-span-2">
            <Textarea value={v.note} onChange={(e) => set({ note: e.target.value })} rows={2} />
          </Field>
          {!lockActive && <Checkbox label="Aktivna (korisnici se mogu prijaviti)" checked={v.active} onChange={(e) => set({ active: e.target.checked })} />}
        </FormGrid>
      </Dialog>
    </>
  );
}

export interface SiteValue {
  id?: string;
  orgId: string;
  name: string;
  address: string;
  timezone: string;
  profileId: string | null;
  note: string;
}

export function SiteDialog({
  value,
  label,
  profiles,
  variant,
  size,
}: {
  value: SiteValue;
  label: string;
  profiles: { id: string; name: string }[];
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}) {
  const d = useDialog();
  const [v, setV] = useState(value);
  const { run, pending, fields } = useAction(saveSiteAction, { onSuccess: d.close });
  const set = (patch: Partial<SiteValue>) => setV({ ...v, ...patch });
  const isNew = !value.id;
  return (
    <>
      <Button variant={variant ?? (isNew ? 'secondary' : 'ghost')} size={size ?? 'sm'} icon={isNew ? <Plus className="size-4" /> : <Pencil className="size-4" />} onClick={() => { setV(value); d.show(); }}>
        {label}
      </Button>
      <Dialog
        open={d.open}
        onClose={d.close}
        title={isNew ? 'Nova lokacija' : `Lokacija — ${value.name}`}
        size="sm"
        footer={
          <>
            <Button onClick={d.close}>Odustani</Button>
            <Button variant="primary" loading={pending} onClick={() => run({ ...v, id: value.id ?? null })}>
              Spremi
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Naziv" required error={fields.name}>
            <Input value={v.name} onChange={(e) => set({ name: e.target.value })} maxLength={150} autoFocus placeholder="npr. Restoran Centar" />
          </Field>
          <Field label="Adresa">
            <Input value={v.address} onChange={(e) => set({ address: e.target.value })} />
          </Field>
          <Field label="Vremenska zona" error={fields.timezone}>
            <Input value={v.timezone} onChange={(e) => set({ timezone: e.target.value })} placeholder="Europe/Zagreb" />
          </Field>
          <Field label="Zadana konfiguracija (profil)" hint="Vrijedi za uređaje na lokaciji koji nemaju vlastiti profil.">
            <Select value={v.profileId ?? ''} onChange={(e) => set({ profileId: e.target.value || null })} placeholder="— bez profila —" options={profiles.map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
          <Field label="Napomena">
            <Textarea value={v.note} onChange={(e) => set({ note: e.target.value })} rows={2} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}

export interface UserValue {
  id?: string;
  orgId: string;
  name: string;
  email: string;
  active: boolean;
  level: '' | 'view' | 'ops' | 'edit';
}

/** Vanjski korisnik organizacije; uloga slijedi vrstu organizacije. */
export function UserDialog({ value, label, roleLabel, defaultLevel, maxLevel }: { value: UserValue; label: string; roleLabel: string; defaultLevel: string; maxLevel: 'view' | 'ops' | 'edit' }) {
  const d = useDialog();
  const [v, setV] = useState(value);
  const [password, setPassword] = useState('');
  const { run, pending, fields } = useAction(saveMdmUserAction, { onSuccess: d.close });
  const set = (patch: Partial<UserValue>) => setV({ ...v, ...patch });
  const isNew = !value.id;
  const levels = (['view', 'ops', 'edit'] as const).slice(0, ['view', 'ops', 'edit'].indexOf(maxLevel) + 1);
  return (
    <>
      <Button variant={isNew ? 'secondary' : 'ghost'} size="sm" icon={isNew ? <Plus className="size-4" /> : <Pencil className="size-4" />} onClick={() => { setV(value); setPassword(''); d.show(); }}>
        {label}
      </Button>
      <Dialog
        open={d.open}
        onClose={d.close}
        title={isNew ? 'Novi korisnik' : `Korisnik — ${value.name}`}
        size="sm"
        footer={
          <>
            <Button onClick={d.close}>Odustani</Button>
            <Button variant="primary" loading={pending} onClick={() => run({ ...v, id: value.id ?? null, password })}>
              Spremi
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-fg-3">Uloga: <b>{roleLabel}</b> — vidi samo MDM svoje organizacije.</p>
          <Field label="Ime i prezime" required error={fields.name}>
            <Input value={v.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
          </Field>
          <Field label="E-adresa (prijava)" required error={fields.email}>
            <Input type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} autoComplete="off" />
          </Field>
          <Field label={isNew ? 'Lozinka' : 'Nova lozinka'} required={isNew} hint={isNew ? 'Najmanje 8 znakova.' : 'Prazno = bez promjene. Promjena odjavljuje korisnika.'}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Prava na MDM">
            <Select
              value={v.level}
              onChange={(e) => set({ level: e.target.value as UserValue['level'] })}
              options={[{ value: '', label: `Zadano za ulogu (${defaultLevel})` }, ...levels.map((l) => ({ value: l, label: LEVEL_LABEL[l] }))]}
            />
          </Field>
          <Checkbox label="Aktivan" checked={v.active} onChange={(e) => set({ active: e.target.checked })} />
        </div>
      </Dialog>
    </>
  );
}

export function ResetPasswordDialog({ id, name }: { id: string; name: string }) {
  const d = useDialog();
  const [password, setPassword] = useState('');
  const { run, pending } = useAction(resetMdmPasswordAction, { onSuccess: d.close });
  return (
    <>
      <Button variant="ghost" size="sm" icon={<KeyRound className="size-4" />} onClick={() => { setPassword(''); d.show(); }}>
        Lozinka
      </Button>
      <Dialog
        open={d.open}
        onClose={d.close}
        title={`Nova lozinka — ${name}`}
        size="sm"
        footer={
          <>
            <Button onClick={d.close}>Odustani</Button>
            <Button variant="primary" loading={pending} disabled={password.length < 8} onClick={() => run({ id, password })}>
              Postavi
            </Button>
          </>
        }
      >
        <Field label="Nova lozinka" hint="Najmanje 8 znakova. Korisnik se odjavljuje sa svih uređaja.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
        </Field>
      </Dialog>
    </>
  );
}
