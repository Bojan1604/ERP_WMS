'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { FormError } from '@/components/ui/action';
import { useToast } from '@/components/ui/toast';
import { prepareUpload } from '@/components/warehouse/image-tools';
import { PORTAL_MAX_PHOTOS } from '@/domain/portal';
import { ATTACHMENT_MAX_BYTES } from '@/domain/attachments';
import { formatDate } from '@/domain/dates';

interface Device {
  id: string;
  name: string;
  serial: string;
  warrantyEnd: string | null;
  inWarranty: boolean;
}

/**
 * Prijava kvara s portala: opis, kontakt i do 4 fotografije (smanjene u
 * pregledniku). Šalje se jednim zahtjevom na /portal/api/prijava — nalog i
 * fotografije nastaju u istoj transakciji.
 */
export function ReportFaultButton({ device, defaultContact }: { device: Device; defaultContact: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        Prijavi kvar
      </Button>
      {open && <ReportFaultDialog device={device} defaultContact={defaultContact} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReportFaultDialog({ device, defaultContact, onClose }: { device: Device; defaultContact: string; onClose: () => void }) {
  const [issue, setIssue] = useState('');
  const [contact, setContact] = useState(defaultContact);
  const [photos, setPhotos] = useState<Array<{ file: File; url: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const router = useRouter();

  // pregledne sličice se oslobađaju pri zatvaranju
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const addFiles = async (list: FileList | null) => {
    const all = [...(list ?? [])];
    const files = all.slice(0, PORTAL_MAX_PHOTOS - photos.length);
    if (all.length > files.length) toast('bad', `Najviše ${PORTAL_MAX_PHOTOS} fotografije po prijavi — višak nije dodan.`);
    const next: Array<{ file: File; url: string }> = [];
    for (const f of files) {
      try {
        const file = await prepareUpload(f, { maxBytes: ATTACHMENT_MAX_BYTES });
        const url = URL.createObjectURL(file);
        urls.current.push(url);
        next.push({ file, url });
      } catch (e) {
        toast('bad', e instanceof Error ? e.message : 'Slika se ne može obraditi.');
      }
    }
    setPhotos((p) => [...p, ...next].slice(0, PORTAL_MAX_PHOTOS));
  };

  const send = async () => {
    if (!issue.trim()) return setError('Opišite kvar.');
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set('itemId', device.id);
      fd.set('issue', issue.trim());
      fd.set('contact', contact.trim());
      for (const p of photos) fd.append('photo', p.file, p.file.name);
      const res = await fetch('/portal/api/prijava', { method: 'POST', body: fd });
      const out = (await res.json().catch(() => ({ ok: false, error: 'Prijava nije uspjela — pokušajte ponovno.' }))) as { ok: boolean; error?: string; data?: { id: string } };
      if (!out.ok || !out.data) {
        setError(out.error ?? 'Prijava nije uspjela — pokušajte ponovno.');
        return;
      }
      toast('ok', 'Kvar je prijavljen — javit ćemo se s uputama za dostavu ili servis.');
      onClose();
      router.push(`/portal/prijave/${out.data.id}`);
      // okvir portala (značka „Moje prijave") se ne renderira ponovno sam
      router.refresh();
    } catch {
      setError('Nema veze s poslužiteljem — pokušajte ponovno.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Prijava kvara — ${device.name}`}
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button variant="primary" loading={busy} onClick={send}>
            Pošalji prijavu
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-fg-3">
          Serijski broj <span className="font-mono text-fg">{device.serial}</span>
          {device.warrantyEnd && ` · jamstvo do ${formatDate(device.warrantyEnd)}${device.inWarranty ? '' : ' (isteklo — servis se naplaćuje)'}`}
        </p>
        <Field label="Opis kvara" required>
          <Textarea rows={4} value={issue} onChange={(e) => setIssue(e.target.value)} maxLength={4000} placeholder="Što se događa, od kada, u kojim situacijama…" autoFocus />
        </Field>
        <Field label="Kontakt za dogovor (telefon ili e-adresa)">
          <Input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} className="h-10" />
        </Field>
        <div>
          <p className="mb-1 text-sm font-medium text-fg-2">Fotografije kvara (neobavezno, do {PORTAL_MAX_PHOTOS})</p>
          <div className="flex flex-wrap gap-2">
            {photos.map((p, i) => (
              <div key={p.url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.file.name} className="size-20 rounded-md border border-line object-cover" />
                <button
                  type="button"
                  onClick={() => setPhotos((list) => list.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-panel text-fg-2 shadow"
                  aria-label="Ukloni sliku"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            {photos.length < PORTAL_MAX_PHOTOS && (
              <label className="grid size-20 cursor-pointer place-items-center rounded-md border border-dashed border-line-strong text-fg-3 hover:bg-muted">
                <span className="flex flex-col items-center gap-1 text-xs">
                  <Camera className="size-5" />
                  Dodaj
                </span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    void addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </div>
        </div>
        <FormError error={error} />
      </div>
    </Dialog>
  );
}
