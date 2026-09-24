'use client';

import { useState } from 'react';
import Link from 'next/link';
import { RefreshCw, RotateCcw, Save } from 'lucide-react';
import type { Platform } from '@/domain/mdm';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { ActionButton, FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Badge, Card, Notice } from '@/components/ui/misc';
import { ConfigEditor } from './config-editor';
import { fromEditor, type EditorConfig, type LibraryApp } from './config-model';

export interface DeviceConfigProps {
  device: { id: string; name: string; platform: Platform; status: string; configVersion: number; appliedConfigVersion: number; profileId: string | null };
  site: { id: string; name: string; profile: { id: string; name: string } | null } | null;
  profile: { id: string; name: string; version: number; own: boolean; editable: boolean } | null;
  profiles: { id: string; name: string; orgId: string | null }[];
  editor: EditorConfig;
  inherited: string[];
  hasOverrides: boolean;
  overridesJson: string;
  effectiveJson: string;
  library: LibraryApp[];
  pendingApply: number;
  canEdit: boolean;
  actions: {
    setProfile: ServerAction<{ deviceId: string; profileId: string | null }>;
    save: ServerAction<unknown>;
    clear: ServerAction<{ deviceId: string }>;
    apply: ServerAction<{ deviceId: string }>;
  };
}

/** Konfiguracija uređaja: koji profil vrijedi, izmjene samo za uređaj, primjena. */
export function DeviceConfig(p: DeviceConfigProps) {
  const { device: d } = p;
  const [value, setValue] = useState(p.editor);
  const [dirty, setDirty] = useState(false);
  const [profileId, setProfileId] = useState(d.profileId ?? '');
  const save = useAction(p.actions.save, {
    onSuccess: () => {
      setDirty(false);
      setValue((v) => ({ ...v, settings: { ...v.settings, wifi: v.settings.wifi.map((w) => ({ ...w, hasPassword: w.security !== 'NONE' && (w.hasPassword || !!w.password), password: '', origSsid: w.ssid })) } }));
    },
  });
  const setProfile = useAction(p.actions.setProfile);
  const applied = d.appliedConfigVersion >= d.configVersion;
  const readOnly = !p.canEdit;

  const stored = (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <p className="mb-1 text-sm font-medium">Izmjene uređaja (spremljeno)</p>
        <pre className="max-h-[60vh] overflow-auto scroll-slim rounded-lg bg-muted p-3 font-mono text-xs">{p.overridesJson}</pre>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium">Učinkovita konfiguracija v{d.configVersion} (što agent dobiva)</p>
        <pre className="max-h-[60vh] overflow-auto scroll-slim rounded-lg bg-muted p-3 font-mono text-xs">{p.effectiveJson}</pre>
      </div>
    </div>
  );

  return (
    <div className="space-y-4 pb-16">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Stanje konfiguracije">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-base">
              Primijenjena verzija <b className="tnum">{d.appliedConfigVersion}</b> / trenutna <b className="tnum">{d.configVersion}</b>
            </span>
            {applied ? <Badge tone="ok">primijenjeno</Badge> : <Badge tone="warn">čeka primjenu</Badge>}
            {p.pendingApply > 0 && <Badge tone="info">naredba „Primijeni" čeka uređaj</Badge>}
          </div>
          <p className="mt-2 text-sm text-fg-3">Agent preuzima novu konfiguraciju pri sljedećem javljanju (svakih 60 s). „Primijeni sada" šalje i naredbu da je odmah ponovno primijeni.</p>
          {p.canEdit && d.status === 'ENROLLED' && (
            <ActionButton className="mt-3" action={p.actions.apply} input={{ deviceId: d.id }} icon={<RefreshCw className="size-4" />}>
              Primijeni sada
            </ActionButton>
          )}
        </Card>
        <Card title="Konfiguracija">
          <p className="mb-2 text-base">
            {p.profile ? (
              <>
                <Link prefetch={false} href={`/mdm/profili/${p.profile.id}`} className="font-medium hover:underline">
                  {p.profile.name}
                </Link>{' '}
                <span className="text-fg-3">(v{p.profile.version})</span> — {p.profile.own ? 'vlastita konfiguracija uređaja' : `preko lokacije ${p.site?.name ?? ''}`}
              </>
            ) : (
              <span className="text-fg-3">Uređaj nema konfiguraciju{p.site ? ` (lokacija ${p.site.name} je nema)` : ' (nije na lokaciji)'} — vrijede samo izmjene ispod.</span>
            )}
          </p>
          {p.canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                className="max-w-sm"
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                placeholder={p.site ? `Konfiguracija lokacije${p.site.profile ? ` (${p.site.profile.name})` : ' (nema)'}` : '(bez vlastite konfiguracije)'}
                options={p.profiles.map((x) => ({ value: x.id, label: x.name }))}
              />
              <Button loading={setProfile.pending} disabled={profileId === (d.profileId ?? '')} onClick={() => setProfile.run({ deviceId: d.id, profileId: profileId || null })}>
                Postavi
              </Button>
            </div>
          )}
        </Card>
      </div>

      {p.hasOverrides && <Notice tone="info">Uređaj ima vlastite izmjene u odnosu na konfiguraciju — spremaju se samo polja koja se razlikuju.</Notice>}
      <div className="rounded-lg bg-panel p-4 shadow-[var(--shadow-panel)]">
        <h2 className="mb-2 text-md font-semibold">Izmjene samo za ovaj uređaj</h2>
        <ConfigEditor
          value={value}
          onChange={(v) => {
            setValue(v);
            setDirty(true);
          }}
          platform={d.platform}
          library={p.library}
          readOnly={readOnly}
          inherited={p.inherited}
          trailing={[{ key: 'stored', label: 'Spremljeno', content: stored }]}
        />
      </div>

      {!readOnly && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 rounded-lg bg-panel/95 px-4 py-2.5 shadow-[var(--shadow-pop)] backdrop-blur">
          <FormError error={save.error} />
          <span className="mr-auto text-sm text-fg-3">{dirty ? <span className="font-medium text-warn">nespremljene promjene</span> : 'spremljeno'}</span>
          {p.hasOverrides && (
            <ActionButton
              action={p.actions.clear}
              input={{ deviceId: d.id }}
              icon={<RotateCcw className="size-4" />}
              confirm="Ukloniti sve izmjene uređaja? Vrijedit će samo konfiguracija lokacije/profila."
              confirmLabel="Ukloni izmjene"
            >
              Ukloni izmjene
            </ActionButton>
          )}
          <Button variant="primary" loading={save.pending} icon={<Save className="size-4" />} onClick={() => save.run({ deviceId: d.id, ...fromEditor(value) })}>
            Spremi izmjene
          </Button>
        </div>
      )}
    </div>
  );
}
