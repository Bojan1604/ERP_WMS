'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2, Paperclip, Trash2 } from 'lucide-react';
import { Button, buttonClass } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { ATTACHMENT_MAX_DOC_BYTES, ATTACHMENT_MAX_PER_ENTITY, isImageMime, type DocAttachmentEntity } from '@/domain/attachments';
import { FilePick, Lightbox, Thumb, attachmentUrl, type AttachmentMeta, type LightboxItem } from '@/components/warehouse/attachments';
import { prepareUpload } from '@/components/warehouse/image-tools';

export type { AttachmentMeta, DocAttachmentEntity };

const MB = ATTACHMENT_MAX_DOC_BYTES / 1024 / 1024;

const fmtSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} kB`);

/**
 * Prilozi dokumenta (ugovor, račun, ulazni račun, narudžbenica, primka, trošak,
 * servisni nalog): popis sa sličicama, pregled, preuzimanje, dodavanje više
 * datoteka odjednom (PDF i slike do 10 MB; slike se smanjuju u pregledniku)
 * i brisanje uz potvrdu. Prava provjerava API (/api/prilozi) po vrsti zapisa;
 * `canEdit` samo skriva gumbe.
 *
 * `initial` (s poslužitelja: `listAttachments(db, companyId, entity, [id])`)
 * izbjegava dodatni zahtjev; bez njega se popis učita pri prikazu.
 */
export function Attachments({
  entity,
  id,
  canEdit,
  initial,
  empty = 'Nema priloga.',
  className,
  onChange,
}: {
  entity: DocAttachmentEntity;
  id: string;
  canEdit: boolean;
  initial?: AttachmentMeta[];
  empty?: string;
  className?: string;
  /** Poziva se s novim brojem priloga nakon dodavanja/brisanja (npr. za oznaku u zaglavlju). */
  onChange?: (count: number) => void;
}) {
  const [list, setList] = useState<AttachmentMeta[] | null>(initial ?? null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (initial) return;
    let live = true;
    fetch(`/api/prilozi?entity=${encodeURIComponent(entity)}&entityId=${encodeURIComponent(id)}`)
      .then((r) => r.json() as Promise<{ ok: boolean; data?: AttachmentMeta[]; error?: string }>)
      .then((out) => {
        if (!live) return;
        if (out.ok && out.data) setList(out.data);
        else {
          setList([]);
          if (out.error) toast('bad', out.error);
        }
      })
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, id]);

  const cur = list ?? [];
  const max = ATTACHMENT_MAX_PER_ENTITY;
  const left = max - cur.length;
  const items: LightboxItem[] = cur.map((a) => ({ key: a.id, src: attachmentUrl(a.id), name: a.fileName, image: isImageMime(a.mime) }));

  const update = (next: AttachmentMeta[]) => {
    setList(next);
    onChange?.(next.length);
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    const picked = files.slice(0, Math.max(0, left));
    if (files.length > picked.length) toast('bad', `Najviše ${max} priloga — dodano je samo ${picked.length}.`);
    if (!picked.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('entity', entity);
      fd.set('entityId', id);
      for (const f of picked) {
        const p = await prepareUpload(f, { maxBytes: ATTACHMENT_MAX_DOC_BYTES, maxSide: 2400 });
        fd.append('file', p, p.name);
      }
      const res = await fetch('/api/prilozi', { method: 'POST', body: fd });
      const out = (await res.json().catch(() => ({ ok: false, error: 'Greška pri slanju.' }))) as { ok: boolean; error?: string; data?: AttachmentMeta[] };
      if (!out.ok || !out.data) throw new Error(out.error ?? 'Greška pri slanju.');
      update([...cur, ...out.data]);
      toast('ok', out.data.length === 1 ? 'Prilog je dodan.' : `Dodano priloga: ${out.data.length}.`);
    } catch (e) {
      toast('bad', e instanceof Error ? e.message : 'Greška pri slanju.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (attId: string) => {
    setBusy(true);
    try {
      const res = await fetch(attachmentUrl(attId), { method: 'DELETE' });
      const out = (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; error?: string };
      if (!out.ok) throw new Error(out.error ?? 'Brisanje nije uspjelo.');
      update(cur.filter((a) => a.id !== attId));
      setOpen(null);
      setConfirmDel(null);
      toast('ok', 'Prilog je obrisan.');
    } catch (e) {
      toast('bad', e instanceof Error ? e.message : 'Brisanje nije uspjelo.');
    } finally {
      setBusy(false);
    }
  };

  const deleteButton = (key: string) =>
    confirmDel === key ? (
      <Button size="sm" variant="danger" loading={busy} icon={<Trash2 className="size-3.5" />} onClick={() => void remove(key)}>
        Potvrdi brisanje
      </Button>
    ) : (
      <Button size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDel(key)}>
        Obriši
      </Button>
    );

  return (
    <div data-attachments={entity} className={className}>
      {list === null ? (
        <p className="flex items-center gap-2 text-sm text-fg-3">
          <Loader2 className="size-3.5 animate-spin" /> Učitavanje priloga…
        </p>
      ) : cur.length ? (
        <ul className="flex flex-wrap gap-3">
          {items.map((it, i) => (
            <li key={it.key} className="w-24">
              <Thumb item={it} onClick={() => setOpen(i)} className="size-24" />
              <p className="mt-0.5 truncate text-xs text-fg-2" title={it.name}>
                {it.name}
              </p>
              <p className="flex items-center justify-between text-[11px] text-fg-4">
                <span>{fmtSize(cur[i].size)}</span>
                <a href={`${it.src}?preuzmi`} className="text-fg-3 hover:text-fg" title="Preuzmi" aria-label={`Preuzmi ${it.name}`}>
                  <Download className="size-3.5" />
                </a>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-3">{empty}</p>
      )}
      {canEdit && list !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <FilePick disabled={busy || left <= 0} onFiles={upload} icon={busy ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}>
            Dodaj prilog
          </FilePick>
          <span className="text-xs text-fg-3">
            {cur.length}/{max} · PDF i slike do {MB} MB
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
        actions={(it) => (
          <>
            <a href={`${it.src}?preuzmi`} className={cn(buttonClass('secondary', 'sm'))}>
              <Download className="size-3.5" /> Preuzmi
            </a>
            {canEdit && deleteButton(it.key)}
          </>
        )}
      />
    </div>
  );
}
