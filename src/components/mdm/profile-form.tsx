'use client';

import { useState } from 'react';
import { MapPin, Save } from 'lucide-react';
import type { Platform } from '@/domain/mdm';
import { PLATFORM_LABEL } from '@/domain/mdm';
import { Button } from '@/components/ui/button';
import { Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { ActionForm, FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Badge, Notice } from '@/components/ui/misc';
import { ConfigEditor } from './config-editor';
import { fromEditor, type EditorConfig, type LibraryApp } from './config-model';
import { ProfileSites, type SiteOption } from './profile-sites';

export interface ProfileHead {
  id: string;
  name: string;
  platform: Platform;
  orgId: string | null;
  orgName: string | null;
  note: string | null;
  version: number;
}

/** Uređivač postojeće konfiguracije: Opće + kartice konfiguracije, spremanje jednim gumbom. */
export function ProfileForm({
  head,
  editor,
  library,
  sites,
  devices,
  readOnly,
  saveAction,
  assignAction,
  canAssign,
}: {
  head: ProfileHead;
  editor: EditorConfig;
  library: LibraryApp[];
  sites: SiteOption[];
  devices: number;
  readOnly: boolean;
  canAssign: boolean;
  saveAction: ServerAction<unknown, { version: number; affected: number }>;
  assignAction: ServerAction<{ profileId: string; siteIds: string[] }>;
}) {
  const [value, setValue] = useState(editor);
  const [name, setName] = useState(head.name);
  const [note, setNote] = useState(head.note ?? '');
  const [dirty, setDirty] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const { run, pending, error } = useAction(saveAction, {
    onSuccess: () => {
      setDirty(false);
      // nove lozinke su spremljene — polja se prazne (prikazuje se „spremljena")
      setValue((v) => ({ ...v, settings: { ...v.settings, wifi: v.settings.wifi.map((w) => ({ ...w, hasPassword: w.security !== 'NONE' && (w.hasPassword || !!w.password), password: '', origSsid: w.ssid })) } }));
    },
  });
  const change = (v: EditorConfig) => {
    setValue(v);
    setDirty(true);
  };
  const assigned = sites.filter((s) => s.assigned);

  const general = (
    <div className="space-y-4">
      <FormGrid cols={2}>
        <Field label="Naziv" required>
          <Input
            value={name}
            disabled={readOnly}
            maxLength={120}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <FormGrid cols={2}>
          <Field label="Platforma">
            <Input value={PLATFORM_LABEL[head.platform]} disabled />
          </Field>
          <Field label="Vlasnik">
            <Input value={head.orgName ?? 'Zajednička (svi)'} disabled />
          </Field>
        </FormGrid>
      </FormGrid>
      <Field label="Napomena">
        <Textarea
          value={note}
          rows={2}
          disabled={readOnly}
          onChange={(e) => {
            setNote(e.target.value);
            setDirty(true);
          }}
        />
      </Field>
      <div className="rounded-lg border border-line p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">
            Lokacija: {assigned.length} · uređaja: {devices}
          </p>
          {canAssign && (
            <Button size="sm" icon={<MapPin className="size-3.5" />} onClick={() => setAssigning(true)}>
              Dodijeli lokacijama
            </Button>
          )}
        </div>
        {assigned.length ? (
          <div className="flex flex-wrap gap-1.5">
            {assigned.map((s) => (
              <Badge key={s.id} tone="brand">
                {s.org} › {s.name}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-fg-3">Konfiguracija još nije dodijeljena nijednoj lokaciji. Uređaj je može dobiti i izravno (kartica Konfiguracija na uređaju).</p>
        )}
      </div>
    </div>
  );

  return (
    <div className="pb-16">
      {readOnly && <Notice tone="info">Zajedničku konfiguraciju mijenja samo vlasnik sustava. Možete je kopirati („Kopiraj") i prilagoditi kopiju.</Notice>}
      <div className="rounded-lg bg-panel p-4 shadow-[var(--shadow-panel)]">
        <ConfigEditor value={value} onChange={change} platform={head.platform} library={library} readOnly={readOnly} leading={[{ key: 'general', label: 'Opće', content: general }]} />
      </div>
      {!readOnly && (
        <div className="sticky bottom-0 z-10 -mx-1 mt-3 flex flex-wrap items-center justify-end gap-3 rounded-lg bg-panel/95 px-4 py-2.5 shadow-[var(--shadow-pop)] backdrop-blur">
          <FormError error={error} />
          <span className="mr-auto text-sm text-fg-3">
            v{head.version} · {dirty ? <span className="font-medium text-warn">nespremljene promjene</span> : 'spremljeno'} · primijenit će se na {devices} uređaja
          </span>
          <Button variant="primary" loading={pending} icon={<Save className="size-4" />} onClick={() => run({ id: head.id, name, note, platform: head.platform, orgId: head.orgId, ...fromEditor(value) })}>
            Spremi
          </Button>
        </div>
      )}
      {canAssign && <ProfileSites open={assigning} onClose={() => setAssigning(false)} profileId={head.id} sites={sites} action={assignAction} />}
    </div>
  );
}

/** Nova konfiguracija: naziv, platforma, vlasnik — ostalo u uređivaču nakon stvaranja. */
export function NewProfileForm({ action, orgs, allowShared }: { action: ServerAction<FormData>; orgs: { value: string; label: string }[]; allowShared: boolean }) {
  return (
    <ActionForm action={action} className="max-w-2xl space-y-4 rounded-lg bg-panel p-4 shadow-[var(--shadow-panel)]" successMessage="Konfiguracija stvorena.">
      {({ pending, error, fields }) => (
        <>
          <FormError error={error} />
          <Field label="Naziv" required error={fields.name}>
            <Input name="name" maxLength={120} autoFocus placeholder="npr. Konobarski terminali — restoran" />
          </Field>
          <FormGrid cols={2}>
            <Field label="Platforma" required hint="Ne mijenja se nakon stvaranja.">
              <Select name="platform" defaultValue="ANDROID" options={[{ value: 'ANDROID', label: 'Android (terminali, dlanovnici)' }, { value: 'WINDOWS', label: 'Windows (računala, POS)' }]} />
            </Field>
            <Field label="Vlasnik" hint={allowShared ? 'Zajedničku vide i koriste svi distributeri i klijenti.' : undefined}>
              <Select name="orgId" defaultValue={allowShared ? '' : orgs[0]?.value} options={orgs} placeholder={allowShared ? 'Zajednička (svi)' : undefined} />
            </Field>
          </FormGrid>
          <Field label="Napomena">
            <Textarea name="note" rows={2} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={pending}>
              Stvori
            </Button>
          </div>
        </>
      )}
    </ActionForm>
  );
}
