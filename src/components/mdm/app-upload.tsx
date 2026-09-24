'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import { Button, type ButtonVariant } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { FormError } from '@/components/ui/action';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { bytes } from './common';
import { ProgressBar, useUpload } from './file-upload';

const MAX_MB = 200;

/**
 * Učitavanje aplikacije ili nove verzije: Android APK (paket i verzija se čitaju
 * iz datoteke) ili Windows MSI/EXE (naziv, ProductCode, verzija i argumenti tihe
 * instalacije se upisuju).
 */
export function AppUploadButton({
  app,
  orgs = [],
  allowShared = false,
  label = 'Učitaj aplikaciju',
  variant = 'primary',
}: {
  /** Nova verzija postojeće aplikacije. */
  app?: { id: string; name: string; platform: 'ANDROID' | 'WINDOWS'; packageName: string; installArgs: string | null };
  orgs?: { value: string; label: string }[];
  allowShared?: boolean;
  label?: string;
  variant?: ButtonVariant;
}) {
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<'ANDROID' | 'WINDOWS'>(app?.platform ?? 'ANDROID');
  const [file, setFile] = useState<File | null>(null);
  const [f, setF] = useState({ appName: '', version: '', versionCode: '', packageName: '', installArgs: app?.installArgs ?? '', notes: '', orgId: allowShared ? '' : (orgs[0]?.value ?? '') });
  const up = useUpload();
  const router = useRouter();
  const toast = useToast();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const windows = platform === 'WINDOWS';
  const ext = file?.name.split('.').pop()?.toLowerCase() ?? '';
  const wrongExt = !!file && (windows ? !['msi', 'exe'].includes(ext) : ext !== 'apk');
  const tooBig = !!file && file.size > MAX_MB * 1024 * 1024;

  const pick = (fl: File | null) => {
    setFile(fl);
    if (!fl || !windows) return;
    const e = fl.name.split('.').pop()?.toLowerCase();
    // zadani argumenti tihe instalacije: MSI /qn, NSIS EXE /S
    setF((x) => ({ ...x, installArgs: x.installArgs || (e === 'msi' ? '/qn' : '/S'), appName: x.appName || (app ? '' : fl.name.replace(/\.(msi|exe)$/i, '').replace(/[-_]?v?\d+(\.\d+)+.*$/, '')) }));
  };

  const submit = async () => {
    if (!file) return;
    const r = await up.run(file, {
      kind: 'APP',
      platform,
      appId: app?.id,
      orgId: app ? null : f.orgId,
      notes: f.notes,
      ...(windows ? { appName: f.appName, version: f.version, versionCode: f.versionCode, packageName: f.packageName, installArgs: f.installArgs } : { appName: f.appName, version: f.version }),
    });
    if (!r) return;
    toast('ok', `Učitano: ${String(r.name)} ${String(r.version)}`);
    setOpen(false);
    setFile(null);
    if (!app && r.appId) router.push(`/mdm/aplikacije/${String(r.appId)}`);
    else router.refresh();
  };

  return (
    <>
      <Button variant={variant} icon={<Upload className="size-4" />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => !up.busy && setOpen(false)}
        title={app ? `Nova verzija: ${app.name}` : 'Učitaj aplikaciju'}
        footer={
          <>
            <Button disabled={up.busy} onClick={() => setOpen(false)}>
              Odustani
            </Button>
            <Button variant="primary" loading={up.busy} disabled={!file || wrongExt || tooBig || (windows && (!(f.appName || app) || !f.version))} onClick={submit}>
              Učitaj
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormError error={up.error} />
          {!app && (
            <FormGrid cols={2}>
              <Field label="Platforma">
                <Select
                  value={platform}
                  onChange={(e) => {
                    setPlatform(e.target.value as 'ANDROID' | 'WINDOWS');
                    setFile(null);
                  }}
                  options={[
                    { value: 'ANDROID', label: 'Android (.apk)' },
                    { value: 'WINDOWS', label: 'Windows (.msi / .exe)' },
                  ]}
                />
              </Field>
              {(orgs.length > 0 || allowShared) && (
                <Field label="Vidljivo" hint={allowShared ? 'Zajedničku koriste svi.' : undefined}>
                  <Select value={f.orgId} onChange={set('orgId')} options={orgs} placeholder={allowShared ? 'Zajednička (svi)' : undefined} />
                </Field>
              )}
            </FormGrid>
          )}
          <Field
            label="Datoteka"
            hint={file ? `${file.name} · ${bytes(file.size)}` : `Najviše ${MAX_MB} MB.`}
            error={wrongExt ? (windows ? 'Odaberite .msi ili .exe.' : 'Odaberite .apk.') : tooBig ? `Veće od ${MAX_MB} MB.` : null}
          >
            <input key={platform} type="file" accept={windows ? '.msi,.exe' : '.apk'} className="block w-full text-sm" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          </Field>
          {windows ? (
            <>
              <FormGrid cols={2}>
                <Field label="Naziv aplikacije" required={!app}>
                  <Input value={f.appName} onChange={set('appName')} placeholder={app?.name} maxLength={120} />
                </Field>
                <Field label="Verzija" required>
                  <Input value={f.version} onChange={set('version')} placeholder="npr. 5.2.1" maxLength={50} />
                </Field>
              </FormGrid>
              <FormGrid cols={2}>
                {!app && (
                  <Field label="ProductCode / identifikator" hint={`MSI ProductCode {GUID} ili naziv pod kojim se vidi u „Programi i značajke". Prazno = naziv.`}>
                    <Input value={f.packageName} onChange={set('packageName')} placeholder="{XXXXXXXX-XXXX-…}" maxLength={200} />
                  </Field>
                )}
                <Field label="Broj verzije (opcionalno)" hint="Cijeli broj za usporedbu starije/novije">
                  <Input value={f.versionCode} inputMode="numeric" onChange={set('versionCode')} />
                </Field>
              </FormGrid>
              <Field label="Argumenti tihe instalacije" hint="MSI: /qn (agent poziva msiexec /i paket.msi /qn). NSIS EXE: /S, Inno Setup: /VERYSILENT /NORESTART.">
                <Input value={f.installArgs} onChange={set('installArgs')} className="font-mono" maxLength={500} />
              </Field>
            </>
          ) : (
            <>
              <Notice tone="info">Paket, verzija i naziv čitaju se iz APK-a. Upišite naziv ili verziju samo ako ih želite drukčije prikazati.</Notice>
              <FormGrid cols={2}>
                <Field label="Naziv (opcionalno)">
                  <Input value={f.appName} onChange={set('appName')} placeholder={app?.name ?? 'iz APK-a'} maxLength={120} />
                </Field>
                <Field label="Verzija (opcionalno)">
                  <Input value={f.version} onChange={set('version')} placeholder="versionName iz APK-a" maxLength={50} />
                </Field>
              </FormGrid>
            </>
          )}
          <Field label="Bilješke uz verziju">
            <Textarea rows={2} value={f.notes} onChange={set('notes')} maxLength={2000} />
          </Field>
          <ProgressBar pct={up.progress} />
        </div>
      </Dialog>
    </>
  );
}
