'use client';

import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { FormError } from '@/components/ui/action';
import { useToast } from '@/components/ui/toast';
import { bytes } from './common';
import { FileInput } from '@/components/ui/file-input';

/**
 * Prijenos u MDM knjižnicu: tijelo zahtjeva je sama datoteka (bez multiparta),
 * podaci u query stringu; napredak kroz XMLHttpRequest.
 */
export function uploadFile(file: File, params: Record<string, string | null | undefined>, onProgress: (pct: number) => void) {
  return new Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }>((resolve) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    q.set('name', file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/mdm/files/upload?${q}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch {
        resolve({ ok: false, error: xhr.status === 413 ? 'Datoteka je prevelika.' : `Greška pri prijenosu (${xhr.status}).` });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: 'Prijenos nije uspio (mreža).' });
    xhr.send(file);
  });
}

/** Stanje prijenosa za dijaloge. */
export function useUpload() {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const run = async (file: File, params: Record<string, string | null | undefined>) => {
    setError(null);
    setProgress(0);
    const r = await uploadFile(file, params, setProgress);
    setProgress(null);
    if (!r.ok) {
      setError(r.error);
      toast('bad', r.error);
      return null;
    }
    return r.data;
  };
  return { run, progress, error, busy: progress !== null };
}

export function ProgressBar({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  return (
    <div className="mt-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-fg-3">{pct < 100 ? `Prijenos… ${pct} %` : 'Obrada na poslužitelju…'}</p>
    </div>
  );
}

/** Prijenos datoteke (FILE) ili dokumenta (DOC) s odabirom vlasnika. */
export function FileUploadButton({ kind, orgs, allowShared, maxMb, accept, label }: { kind: 'FILE' | 'DOC'; orgs: { value: string; label: string }[]; allowShared: boolean; maxMb: number; accept?: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [orgId, setOrgId] = useState(allowShared ? '' : (orgs[0]?.value ?? ''));
  const input = useRef<HTMLInputElement>(null);
  const up = useUpload();
  const router = useRouter();
  const toast = useToast();
  const tooBig = !!file && file.size > maxMb * 1024 * 1024;
  const submit = async () => {
    if (!file) return;
    const r = await up.run(file, { kind, orgId });
    if (r) {
      toast('ok', `Učitano: ${file.name}`);
      setOpen(false);
      setFile(null);
      router.refresh();
    }
  };
  return (
    <>
      <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => !up.busy && setOpen(false)}
        title={label}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={up.busy}>
              Odustani
            </Button>
            <Button variant="primary" loading={up.busy} disabled={!file || tooBig} onClick={submit}>
              Učitaj
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormError error={up.error} />
          <Field label="Datoteka" hint={file ? `${file.name} · ${bytes(file.size)}` : `Najviše ${maxMb} MB.`} error={tooBig ? `Datoteka je veća od ${maxMb} MB.` : null}>
            <FileInput ref={input} accept={accept} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          {(orgs.length > 0 || allowShared) && (
            <Field label="Vidljivo" hint={allowShared ? 'Zajedničko vide svi distributeri i klijenti.' : undefined}>
              <Select value={orgId} onChange={(e) => setOrgId(e.target.value)} options={orgs} placeholder={allowShared ? 'Zajedničko (svi)' : undefined} />
            </Field>
          )}
          <ProgressBar pct={up.progress} />
        </div>
      </Dialog>
    </>
  );
}
