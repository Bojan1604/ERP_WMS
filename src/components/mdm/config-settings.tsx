'use client';

import { Eye, EyeOff, Lock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Platform } from '@/domain/mdm';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select } from '@/components/ui/field';
import { Badge, Notice } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { KIOSK_BLOCKS, RESTRICTIONS, UPDATE_POLICY_LABEL, type EditorSettings, type EditorWifi } from './config-model';

/** Zabrane koje zaključani način uvijek uključuje (kao „Orderman Mode"). */
const KIOSK_KEYS: string[] = ['noInstallApps', 'noSettings', 'noPlayStore', 'noUsbFileTransfer'];

type Props = { value: EditorSettings; onChange: (v: EditorSettings) => void; platform: Platform; readOnly?: boolean };

/** Prekidač (kao u SCN-u „Orderman Mode" / „ADB"). */
export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3', disabled && 'cursor-default opacity-70')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-brand' : 'bg-line-strong')}
      >
        <span className={cn('absolute top-0.5 size-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      <span>
        <span className="block text-base font-medium">{label}</span>
        {hint && <span className="block text-sm text-fg-3">{hint}</span>}
      </span>
    </label>
  );
}

/** „Zaključani način" (SCN Expert settings): kiosk, zabrane, ADB, servisni PIN. */
export function ConfigLockdown({ value, onChange, platform, readOnly }: Props) {
  const set = (p: Partial<EditorSettings>) => onChange({ ...value, ...p });
  const android = platform === 'ANDROID';
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Toggle
          checked={value.kiosk}
          disabled={readOnly}
          onChange={(kiosk) => set({ kiosk })}
          label="Zaključani način (kiosk)"
          hint="Sigurnosna značajka: konobar/djelatnik ne može mijenjati važne dijelove uređaja."
        />
        <div className="ml-12 rounded-lg bg-muted/60 px-3 py-2 text-sm text-fg-2">
          <p className="mb-1 font-medium">Kad je uključen, na uređaju je onemogućeno:</p>
          <ul className="list-disc pl-5">
            {KIOSK_BLOCKS.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p className="mt-1 text-fg-3">
            {android
              ? 'Na zaslonu je samo aplikacija za pokretanje nakon paljenja (ili popis dopuštenih aplikacija). Izlaz servisnim PIN-om.'
              : 'Windows: dodijeljeni pristup (Assigned Access) za lokalnog korisnika s aplikacijom za pokretanje; izlaz servisnim PIN-om u agentu.'}
          </p>
        </div>
        {android && (
          <Toggle checked={value.adb} disabled={readOnly} onChange={(adb) => set({ adb })} label="ADB (način za razvojne programere)" hint="Omogućuje USB/mrežno otklanjanje pogrešaka. Isključite na uređajima u radu." />
        )}
      </div>

      <div>
        <h3 className="mb-2 text-md font-semibold">Zabrane</h3>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {RESTRICTIONS.map((r) => {
            const off = r.androidOnly && !android;
            const implied = value.kiosk && KIOSK_KEYS.includes(r.key);
            return (
              <label key={r.key} className={cn('flex items-start gap-2 rounded-md border border-line px-3 py-2', off && 'opacity-50')}>
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--color-brand)]"
                  disabled={readOnly || off || implied}
                  checked={!!value.restrictions[r.key] || implied}
                  onChange={(e) => set({ restrictions: { ...value.restrictions, [r.key]: e.target.checked } })}
                />
                <span>
                  <span className="block text-base">
                    {r.label}
                    {r.androidOnly && (
                      <Badge tone="neutral" className="ml-1.5">
                        Android
                      </Badge>
                    )}
                  </span>
                  <span className="block text-sm text-fg-3">{r.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {value.kiosk && <p className="mt-1 text-xs text-fg-3">Zaključani način uvijek uključuje prve četiri zabrane.</p>}
      </div>

      <Field label="Servisni PIN" hint="4–8 znamenki; za izlaz iz zaključanog načina i servisni izbornik agenta na uređaju." className="max-w-xs">
        <Input value={value.maintenancePin} disabled={readOnly} inputMode="numeric" maxLength={8} onChange={(e) => set({ maintenancePin: e.target.value.replace(/\D/g, '') })} placeholder="npr. 2309" />
      </Field>
    </div>
  );
}

const SECURITY = [
  { value: 'WPA2', label: 'WPA2-PSK' },
  { value: 'WPA3', label: 'WPA3-SAE' },
  { value: 'NONE', label: 'Otvorena (bez lozinke)' },
];

/** Wi-Fi mreže. Spremljena lozinka se ne prikazuje; nova se upisuje samo za promjenu. */
export function ConfigNetwork({ value, onChange, readOnly }: Props) {
  const [show, setShow] = useState<number | null>(null);
  const list = value.wifi;
  const set = (wifi: EditorWifi[]) => onChange({ ...value, wifi });
  const patch = (i: number, p: Partial<EditorWifi>) => set(list.map((w, j) => (j === i ? { ...w, ...p } : w)));
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-3">Mreže se dodaju na uređaj redom; prva dostupna se koristi. Preporuke za Wi-Fi instalaciju su na stranici „Dokumenti i mreža".</p>
      {list.map((w, i) => (
        <div key={i} className="rounded-lg border border-line p-3">
          <FormGrid cols={4}>
            <Field label="SSID (naziv mreže)" required>
              <Input value={w.ssid} maxLength={32} disabled={readOnly} onChange={(e) => patch(i, { ssid: e.target.value })} />
            </Field>
            <Field label="Zaštita">
              <Select value={w.security} disabled={readOnly} options={SECURITY} onChange={(e) => patch(i, { security: e.target.value as EditorWifi['security'] })} />
            </Field>
            <Field label="Lozinka" hint={w.security === 'NONE' ? undefined : w.hasPassword ? 'Spremljena — upišite samo za promjenu.' : 'Najmanje 8 znakova.'}>
              <div className="relative">
                <Input
                  type={show === i ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={w.password}
                  maxLength={63}
                  disabled={readOnly || w.security === 'NONE'}
                  placeholder={w.hasPassword ? '••••••••' : ''}
                  onChange={(e) => patch(i, { password: e.target.value })}
                  className="pr-8"
                />
                {w.password && (
                  <button type="button" className="absolute right-2 top-1.5 text-fg-3" onClick={() => setShow(show === i ? null : i)} aria-label="Prikaži lozinku">
                    {show === i ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                )}
              </div>
            </Field>
            <div className="flex items-end justify-between gap-2 pb-1">
              <Checkbox label="skrivena mreža" checked={w.hidden} disabled={readOnly} onChange={(e) => patch(i, { hidden: e.target.checked })} />
              {!readOnly && <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => set(list.filter((_, j) => j !== i))} aria-label="Ukloni mrežu" />}
            </div>
          </FormGrid>
          {w.hasPassword && w.security !== 'NONE' && !w.password && (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-fg-3">
              <Lock className="size-3" /> lozinka je spremljena na poslužitelju i šalje se samo uređajima
            </p>
          )}
        </div>
      ))}
      {!list.length && <Notice tone="neutral">Nema Wi-Fi mreža — uređaji zadržavaju mreže koje već imaju.</Notice>}
      {!readOnly && (
        <Button icon={<Plus className="size-4" />} onClick={() => set([...list, { ssid: '', security: 'WPA2', hidden: false, hasPassword: false, origSsid: null, password: '' }])}>
          Dodaj mrežu
        </Button>
      )}
    </div>
  );
}

const TIMEZONES = ['Europe/Zagreb', 'Europe/Ljubljana', 'Europe/Belgrade', 'Europe/Sarajevo', 'Europe/Vienna', 'Europe/Berlin', 'Europe/London', 'UTC'];

/** Sustav: zaslon, glasnoća, vremenska zona, ažuriranja sustava. */
export function ConfigSystem({ value, onChange, platform, readOnly }: Props) {
  const set = (p: Partial<EditorSettings>) => onChange({ ...value, ...p });
  return (
    <div className="space-y-4">
      <FormGrid cols={3}>
        <Field label="Gašenje zaslona (s)" hint="0 = nikad; prazno = ne mijenja se">
          <Input type="number" min={0} max={86400} value={value.screenTimeoutSec} disabled={readOnly} onChange={(e) => set({ screenTimeoutSec: e.target.value })} />
        </Field>
        <Field label="Glasnoća (%)" hint="prazno = ne mijenja se">
          <Input type="number" min={0} max={100} value={value.volumePct} disabled={readOnly} onChange={(e) => set({ volumePct: e.target.value })} />
        </Field>
        <Field label="Vremenska zona" hint="prazno = zona lokacije / uređaja">
          <Select value={value.timezone} disabled={readOnly} placeholder="(ne mijenja se)" options={[...new Set([...TIMEZONES, ...(value.timezone ? [value.timezone] : [])])].map((z) => ({ value: z, label: z }))} onChange={(e) => set({ timezone: e.target.value })} />
        </Field>
      </FormGrid>
      {platform === 'ANDROID' ? (
        <Field label="Ažuriranja sustava (Android)" className="max-w-md" hint="Razdoblje održavanja sprječava ponovno pokretanje uređaja usred rada.">
          <Select
            value={value.systemUpdates}
            disabled={readOnly}
            placeholder="(zadano proizvođača)"
            options={Object.entries(UPDATE_POLICY_LABEL).map(([k, l]) => ({ value: k, label: l }))}
            onChange={(e) => set({ systemUpdates: e.target.value as EditorSettings['systemUpdates'] })}
          />
        </Field>
      ) : (
        <Notice tone="info">Windows ažuriranja upravljaju se kroz Windows Update / WSUS / Intune; agent ih ne mijenja, samo javlja stanje.</Notice>
      )}
    </div>
  );
}
