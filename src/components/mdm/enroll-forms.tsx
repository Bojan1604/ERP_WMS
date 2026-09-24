'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, QrCode } from 'lucide-react';
import { PLATFORM_LABEL, type Platform } from '@/domain/mdm';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormGrid, Input, Select } from '@/components/ui/field';
import { useAction } from '@/components/ui/action';
import { useToast } from '@/components/ui/toast';
import { createTokenAction, enrollAction } from '@/app/(app)/mdm/upis/actions';

interface Opts {
  orgs: { id: string; label: string }[];
  sites: { id: string; name: string; orgId: string }[];
  profiles?: { id: string; name: string; platform: Platform }[];
}

function OrgSite({ orgs, sites, orgId, siteId, setOrgId, setSiteId }: Opts & { orgId: string; siteId: string; setOrgId: (v: string) => void; setSiteId: (v: string) => void }) {
  const list = sites.filter((s) => s.orgId === orgId);
  return (
    <>
      <Field label="Organizacija / klijent" required>
        <Select
          value={orgId}
          onChange={(e) => {
            setOrgId(e.target.value);
            setSiteId('');
          }}
          placeholder="— odaberite —"
          options={orgs.map((o) => ({ value: o.id, label: o.label }))}
        />
      </Field>
      <Field label="Lokacija" hint={orgId && !list.length ? 'Organizacija nema lokacija — dodajte ih u Organizacijama.' : undefined}>
        <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder="— bez lokacije —" options={list.map((s) => ({ value: s.id, label: s.name }))} disabled={!orgId} />
      </Field>
    </>
  );
}

/**
 * „Upiši uređaj" (kao SCN Enroll Device): kod sa zaslona uređaja + organizacija i lokacija.
 * `initialCode` otvara dijalog odmah (poveznica s uređaja na čekanju).
 */
export function EnrollDialog({ orgs, sites, profiles = [], initialCode, label = 'Upiši uređaj kodom' }: Opts & { initialCode?: string | null; label?: string }) {
  const [open, setOpen] = useState(!!initialCode);
  const [code, setCode] = useState(initialCode ?? '');
  const [orgId, setOrgId] = useState(orgs.length === 1 ? orgs[0].id : '');
  const [siteId, setSiteId] = useState('');
  const [name, setName] = useState('');
  const [profileId, setProfileId] = useState('');
  const { run, pending, error } = useAction(enrollAction);
  useEffect(() => {
    if (initialCode) {
      setCode(initialCode);
      setOpen(true);
    }
  }, [initialCode]);
  const valid = /^\d{6}$/.test(code.replace(/\s/g, '')) && !!orgId;
  return (
    <>
      <Button variant="primary" icon={<KeyRound className="size-4" />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Upis uređaja"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!valid}
              onClick={() => run({ code: code.replace(/\s/g, ''), orgId, siteId: siteId || null, name: name || null, profileId: profileId || null })}
            >
              Upiši
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Kod za upis" hint="Šesteroznamenkasti kod koji agent prikazuje na zaslonu uređaja.">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 7))}
              inputMode="numeric"
              autoComplete="off"
              placeholder="000000"
              autoFocus
              className="h-11 text-center font-mono text-xl tracking-[0.4em]"
            />
          </Field>
          <FormGrid>
            <OrgSite orgs={orgs} sites={sites} orgId={orgId} siteId={siteId} setOrgId={setOrgId} setSiteId={setSiteId} />
            <Field label="Naziv uređaja" hint="Prazno = naziv koji je javio agent.">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="npr. Blagajna 1" />
            </Field>
            <Field label="Konfiguracija" hint="Prazno = profil lokacije.">
              <Select
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                placeholder="— profil lokacije —"
                options={profiles.map((p) => ({ value: p.id, label: `${p.name} (${PLATFORM_LABEL[p.platform]})` }))}
              />
            </Field>
          </FormGrid>
          {error && <p className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">{error}</p>}
        </div>
      </Dialog>
    </>
  );
}

/** Novi ključ za automatski upis (QR za Android, instalacijska naredba za Windows). */
export function CreateTokenDialog({ orgs, sites }: Opts) {
  const [open, setOpen] = useState(false);
  const [orgId, setOrgId] = useState(orgs.length === 1 ? orgs[0].id : '');
  const [siteId, setSiteId] = useState('');
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const { run, pending } = useAction(createTokenAction, { onSuccess: () => setOpen(false) });
  return (
    <>
      <Button icon={<QrCode className="size-4" />} onClick={() => setOpen(true)}>
        Novi ključ za upis
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Novi ključ za automatski upis"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!orgId}
              onClick={() => run({ orgId, siteId: siteId || null, label: label || null, maxUses: maxUses || null, expiresAt: expiresAt || null })}
            >
              Izradi
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-fg-3">Uređaj koji se javi s ovim ključem upisuje se odmah u odabranu organizaciju i lokaciju, bez koda.</p>
          <FormGrid>
            <OrgSite orgs={orgs} sites={sites} orgId={orgId} siteId={siteId} setOrgId={setOrgId} setSiteId={setSiteId} />
            <Field label="Oznaka">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} placeholder="npr. Terminali — sezona 2026" />
            </Field>
            <Field label="Najviše upisa" hint="Prazno = neograničeno.">
              <Input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </Field>
            <Field label="Vrijedi do" hint="Prazno = bez isteka.">
              <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
          </FormGrid>
        </div>
      </Dialog>
    </>
  );
}

/** Gumb za kopiranje teksta (naredba, JSON). */
export function CopyButton({ text, label = 'Kopiraj' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <Button
      size="sm"
      icon={done ? <Check className="size-4" /> : <Copy className="size-4" />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          toast('bad', 'Kopiranje nije uspjelo — označite tekst ručno.');
        }
      }}
    >
      {done ? 'Kopirano' : label}
    </Button>
  );
}
