'use client';

import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Camera, Images, Loader2, X } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { pairCode } from '@/domain/attachments';
import { FilePick, Lightbox, Thumb, type LightboxItem } from './attachments';
import { prepareUpload, readCodes } from './image-tools';

/** Na što se slika može vezati: poznati uređaj (id) ili nepoznati serijski broj. */
export interface PhotoTarget {
  key: string;
  serial: string;
  hint?: string;
}

export interface PickedPhoto {
  id: string;
  file: File;
  url: string;
  target: string | null;
  codes: string[];
  reading: boolean;
}

/** Oslobađa privremene adrese slika kad se odabir odbaci. */
export function releasePhotos(photos: PickedPhoto[]) {
  for (const p of photos) URL.revokeObjectURL(p.url);
}

/**
 * Slike naljepnica prije slanja: svaka se slika smanji, pročita se barkod i
 * slika se upari s uređajem (točan serijski ili serijski kao dio koda).
 * Nepovezanu sliku korisnik veže ručno; jedan uređaj = jedna slika.
 */
export function LabelPhotos({
  targets,
  photos,
  setPhotos,
  allowUnlinked,
  max = 30,
}: {
  targets: PhotoTarget[];
  photos: PickedPhoto[];
  setPhotos: Dispatch<SetStateAction<PickedPhoto[]>>;
  /** Smije li slika ostati nepovezana (općenita slika uz zahtjev). */
  allowUnlinked?: boolean;
  max?: number;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const latest = useRef(photos);
  latest.current = photos;
  // privremene adrese se oslobađaju kad dijalog nestane
  useEffect(() => () => releasePhotos(latest.current), []);

  const add = async (files: File[]) => {
    const room = max - latest.current.length;
    if (files.length > room) toast('bad', `Najviše ${max} slika.`);
    for (const f of files.slice(0, Math.max(0, room))) {
      setBusy((n) => n + 1);
      try {
        const file = await prepareUpload(f);
        const id = crypto.randomUUID();
        const url = URL.createObjectURL(file);
        setPhotos((v) => [...v, { id, file, url, target: null, codes: [], reading: true }]);
        const codes = await readCodes(file);
        setPhotos((v) => {
          const taken = new Set(v.map((p) => p.target).filter(Boolean));
          const target = pairCode(codes, targets.filter((t) => !taken.has(t.key)).map((t) => ({ id: t.key, serial: t.serial })));
          return v.map((p) => (p.id === id ? { ...p, codes, target, reading: false } : p));
        });
      } catch (e) {
        toast('bad', e instanceof Error ? e.message : 'Slika se ne može obraditi.');
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };

  const remove = (id: string) =>
    setPhotos((v) => {
      const p = v.find((x) => x.id === id);
      if (p) URL.revokeObjectURL(p.url);
      return v.filter((x) => x.id !== id);
    });

  const taken = new Set(photos.map((p) => p.target).filter(Boolean));
  const unlinked = photos.filter((p) => !p.target && !p.reading).length;
  const without = targets.filter((t) => !taken.has(t.key));
  const lb: LightboxItem[] = photos.map((p) => ({
    key: p.id,
    src: p.url,
    name: p.file.name,
    image: true,
    caption: p.codes.length ? `Pročitano: ${p.codes.join(', ')}` : 'Kod nije pročitan',
  }));

  return (
    <div className="space-y-2" data-label-photos>
      <div className="flex flex-wrap items-center gap-2">
        <FilePick camera onFiles={add} disabled={photos.length >= max} icon={<Camera className="size-3.5" />}>
          Slikaj
        </FilePick>
        <FilePick multiple onFiles={add} disabled={photos.length >= max} icon={<Images className="size-3.5" />}>
          Galerija
        </FilePick>
        {busy > 0 && <Loader2 className="size-4 animate-spin text-fg-3" aria-label="Obrada slika" />}
      </div>
      {photos.length > 0 && (
        <ul className="space-y-1.5">
          {photos.map((p, i) => (
            <li
              key={p.id}
              data-photo-linked={p.target ? '1' : '0'}
              className={cn('flex items-center gap-2 rounded-md border-l-4 bg-muted/60 p-1.5', p.target ? 'border-l-ok' : allowUnlinked ? 'border-l-line-strong' : 'border-l-bad-strong')}
            >
              <Thumb item={lb[i]} onClick={() => setOpen(i)} className="size-14" />
              <div className="min-w-0 flex-1 space-y-1">
                <select
                  value={p.target ?? ''}
                  onChange={(e) => setPhotos((v) => v.map((x) => (x.id === p.id ? { ...x, target: e.target.value || null } : x)))}
                  className="h-9 w-full min-w-0 rounded-md border border-line bg-panel px-2 font-mono text-sm"
                  aria-label="Uređaj na slici"
                >
                  <option value="">{allowUnlinked ? '— općenita slika —' : 'Nije povezano — odaberite uređaj'}</option>
                  {targets.map((t) => (
                    <option key={t.key} value={t.key} disabled={taken.has(t.key) && p.target !== t.key}>
                      {t.serial}
                      {t.hint ? ` · ${t.hint}` : ''}
                    </option>
                  ))}
                </select>
                <p className="truncate text-xs text-fg-3">
                  {p.reading ? 'Čitam kod…' : p.codes.length ? `Pročitano: ${p.codes.join(', ')}` : 'Kod nije pročitan — povežite ručno'}
                </p>
              </div>
              <button type="button" onClick={() => remove(p.id)} className="grid size-9 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-muted" aria-label="Ukloni sliku">
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {photos.length > 0 && (
        <p className="text-xs text-fg-3">
          {unlinked > 0 && !allowUnlinked && <span className="text-bad-strong">Nepovezanih slika: {unlinked}. </span>}
          {without.length > 0 && targets.length > 1 && (
            <>
              Bez slike ({without.length}): <span className="font-mono">{without.slice(0, 8).map((t) => t.serial).join(', ')}</span>
              {without.length > 8 && ' …'}
            </>
          )}
        </p>
      )}
      <Lightbox items={lb} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </div>
  );
}

/** Naslov i uputa odjeljka sa slikama (ne <label> kao Field — unutra su gumbi za odabir datoteka). */
export function PhotoSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-sm font-medium text-fg-2">{title}</p>
      {children}
      {hint && <p className="mt-1 text-xs text-fg-3">{hint}</p>}
    </div>
  );
}
