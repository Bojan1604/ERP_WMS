'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, ChevronLeft, ChevronRight, ExternalLink, FileText, Loader2, Paperclip, Trash2 } from 'lucide-react';
import { Button, buttonClass } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_PER_ENTITY, isImageMime } from '@/domain/attachments';
import { prepareUpload } from './image-tools';

export interface AttachmentMeta {
  id: string;
  fileName: string;
  mime: string;
  size: number;
  /** Prilog servisnog naloga vidljiv klijentu na portalu. */
  public?: boolean;
}

export const attachmentUrl = (id: string) => `/api/prilozi/${id}`;

export interface LightboxItem {
  key: string;
  src: string;
  name: string;
  image: boolean;
  caption?: ReactNode;
}

/** Sličica priloga (slika ili ikona PDF-a). */
export function Thumb({ item, onClick, className, children }: { item: LightboxItem; onClick: () => void; className?: string; children?: ReactNode }) {
  return (
    <div className={cn('relative size-20 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-line', className)}>
      <button type="button" onClick={onClick} className="block size-full" title={item.name} aria-label={`Otvori ${item.name}`}>
        {item.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.src} alt={item.name} loading="lazy" className="size-full object-cover" />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-1 px-1 text-fg-3">
            <FileText className="size-6" />
            <span className="w-full truncate text-center text-[10px]">{item.name}</span>
          </span>
        )}
      </button>
      {children}
    </div>
  );
}

/** Pregled priloga preko cijelog ekrana; strelice ←/→ listaju. */
export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  actions,
}: {
  items: LightboxItem[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
  actions?: (item: LightboxItem) => ReactNode;
}) {
  const item = index !== null ? items[index] : null;
  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onIndex]);
  return (
    <Dialog
      open={!!item}
      onClose={onClose}
      size="xl"
      title={<span className="block max-w-[60vw] truncate">{item?.name}</span>}
      footer={
        item && (
          <div className="flex w-full flex-wrap items-center gap-2">
            <Button size="sm" icon={<ChevronLeft className="size-4" />} disabled={!index} onClick={() => onIndex(index! - 1)} aria-label="Prethodni" />
            <span className="text-sm tnum text-fg-3">
              {index! + 1} / {items.length}
            </span>
            <Button size="sm" icon={<ChevronRight className="size-4" />} disabled={index === items.length - 1} onClick={() => onIndex(index! + 1)} aria-label="Sljedeći" />
            <span className="flex-1" />
            {actions?.(item)}
            <a href={item.src} target="_blank" rel="noreferrer" className={buttonClass('secondary', 'sm')}>
              <ExternalLink className="size-3.5" /> Otvori
            </a>
          </div>
        )
      }
    >
      {item && (
        <div className="space-y-2">
          {item.caption && <div className="text-sm text-fg-2">{item.caption}</div>}
          {item.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.src} alt={item.name} className="mx-auto max-h-[70dvh] w-auto max-w-full rounded-md object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-fg-3">
              <FileText className="size-10" />
              <a href={item.src} target="_blank" rel="noreferrer" className="link">
                Otvori PDF u novoj kartici
              </a>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

const toItem = (a: AttachmentMeta & { caption?: ReactNode }): LightboxItem => ({
  key: a.id,
  src: attachmentUrl(a.id),
  name: a.fileName,
  image: isImageMime(a.mime),
  caption: a.caption,
});

/** Samo pregled priloga (npr. slike naljepnica na zahtjevu). */
export function AttachmentGallery({ items, className }: { items: Array<AttachmentMeta & { caption?: ReactNode; label?: string | null }>; className?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!items.length) return null;
  const list = items.map(toItem);
  return (
    <>
      <div className={cn('flex flex-wrap gap-2', className)}>
        {items.map((a, i) => (
          <div key={a.id} className="w-20">
            <Thumb item={list[i]} onClick={() => setOpen(i)} />
            {a.label && <p className="mt-0.5 truncate font-mono text-[11px] text-fg-3" title={a.label}>{a.label}</p>}
          </div>
        ))}
      </div>
      <Lightbox items={list} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </>
  );
}

/**
 * Prilozi zapisa: sličice, pregled, dodavanje (kamera ili datoteka) i brisanje.
 * Slike se prije slanja smanjuju na 1600 px (JPEG).
 */
export function Attachments({
  entity,
  entityId,
  initial,
  canAdd,
  canDelete,
  max = ATTACHMENT_MAX_PER_ENTITY,
  empty = 'Nema priloga.',
}: {
  entity: 'item' | 'request';
  entityId: string;
  initial: AttachmentMeta[];
  canAdd: boolean;
  canDelete: boolean;
  max?: number;
  empty?: string;
}) {
  const [list, setList] = useState(initial);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const toast = useToast();
  const items = list.map(toItem);
  const left = max - list.length;

  const upload = async (files: File[]) => {
    if (!files.length) return;
    const picked = [...files].slice(0, Math.max(0, left));
    if (files.length > picked.length) toast('bad', `Najviše ${max} priloga — dodano je samo ${picked.length}.`);
    if (!picked.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('entity', entity);
      fd.set('entityId', entityId);
      for (const f of picked) {
        const p = await prepareUpload(f);
        fd.append('file', p, p.name);
      }
      const res = await fetch('/api/prilozi', { method: 'POST', body: fd });
      const out = (await res.json().catch(() => ({ ok: false, error: 'Greška pri slanju.' }))) as { ok: boolean; error?: string; data?: AttachmentMeta[] };
      if (!out.ok || !out.data) throw new Error(out.error ?? 'Greška pri slanju.');
      setList((v) => [...v, ...out.data!]);
      toast('ok', out.data.length === 1 ? 'Prilog je dodan.' : `Dodano priloga: ${out.data.length}.`);
    } catch (e) {
      toast('bad', e instanceof Error ? e.message : 'Greška pri slanju.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(attachmentUrl(id), { method: 'DELETE' });
      const out = (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; error?: string };
      if (!out.ok) throw new Error(out.error ?? 'Brisanje nije uspjelo.');
      setList((v) => v.filter((a) => a.id !== id));
      setOpen(null);
      setConfirmDel(null);
      toast('ok', 'Prilog je obrisan.');
    } catch (e) {
      toast('bad', e instanceof Error ? e.message : 'Brisanje nije uspjelo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-attachments={entity}>
      {list.length ? (
        <div className="flex flex-wrap gap-2">
          {items.map((it, i) => (
            <Thumb key={it.key} item={it} onClick={() => setOpen(i)} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-fg-3">{empty}</p>
      )}
      {canAdd && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <FilePick camera disabled={busy || left <= 0} onFiles={upload} icon={busy ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}>
            Slikaj
          </FilePick>
          <FilePick disabled={busy || left <= 0} onFiles={upload} icon={<Paperclip className="size-3.5" />}>
            Dodaj datoteku
          </FilePick>
          <span className="text-xs text-fg-3">
            {list.length}/{max} · slike i PDF do 2 MB
          </span>
        </div>
      )}
      <Lightbox
        items={items}
        index={open}
        onIndex={(i) => {
          setOpen(i);
          setConfirmDel(null);
        }}
        onClose={() => {
          setOpen(null);
          setConfirmDel(null);
        }}
        actions={
          canDelete
            ? (it) =>
                confirmDel === it.key ? (
                  <Button size="sm" variant="danger" loading={busy} icon={<Trash2 className="size-3.5" />} onClick={() => void remove(it.key)}>
                    Potvrdi brisanje
                  </Button>
                ) : (
                  <Button size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDel(it.key)}>
                    Obriši
                  </Button>
                )
            : undefined
        }
      />
    </div>
  );
}

/** Gumb za odabir datoteke; `camera` otvara stražnju kameru na mobitelu. */
export function FilePick({
  camera,
  multiple = !camera,
  disabled,
  onFiles,
  icon,
  children,
  className,
  size = 'sm',
}: {
  camera?: boolean;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label className={cn(buttonClass('secondary', size, className), 'cursor-pointer gap-1.5', disabled && 'pointer-events-none opacity-45')}>
      {icon}
      {children}
      <input
        ref={ref}
        type="file"
        className="sr-only"
        disabled={disabled}
        accept={camera ? 'image/*' : ATTACHMENT_ACCEPT}
        {...(camera ? { capture: 'environment' as const } : {})}
        multiple={multiple}
        onChange={(e) => {
          // kopija prije brisanja vrijednosti polja
          onFiles([...(e.target.files ?? [])]);
          // isti se kadar smije ponovno odabrati
          if (ref.current) ref.current.value = '';
        }}
      />
    </label>
  );
}
