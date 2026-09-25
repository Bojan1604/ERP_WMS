'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Camera, Images, Loader2, ScanText } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { ocrMatchAction } from '@/app/(app)/skladiste/skeniranje/actions';
import { OcrUnavailableError, ocrImageText, readImageBarcodes } from './image-read';

function Pick({ camera, multiple, onFiles, disabled, icon, children, title }: { camera?: boolean; multiple?: boolean; onFiles: (f: File[]) => void; disabled?: boolean; icon: ReactNode; children: ReactNode; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label title={title} className={cn(buttonClass('secondary', 'sm'), 'cursor-pointer gap-1.5', disabled && 'pointer-events-none opacity-45')}>
      {icon}
      {children}
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="sr-only"
        disabled={disabled}
        multiple={multiple}
        {...(camera ? { capture: 'environment' as const } : {})}
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          if (ref.current) ref.current.value = '';
        }}
      />
    </label>
  );
}

/**
 * Očitanje s fotografije u skeneru: „Galerija" i „Slikaj" čitaju barkodove sa
 * slike (ZXing), „Tekst (OCR)" čita serijski broj s naljepnice bez barkoda.
 * OCR se učitava tek na klik; bez interneta javlja da treba upisati ručno.
 */
export function ImageScan({ onCodes }: { onCodes: (codes: string[]) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);

  const barcodes = async (files: File[]) => {
    const all: string[] = [];
    setMsg(null);
    try {
      for (let i = 0; i < files.length; i++) {
        setBusy(`Tražim barkodove — slika ${i + 1} od ${files.length}…`);
        for (const c of await readImageBarcodes(files[i])) if (!all.includes(c)) all.push(c);
      }
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof Error ? e.message : 'Slika se ne može pročitati.' });
    } finally {
      setBusy(null);
    }
    if (all.length) {
      setMsg({ tone: 'ok', text: `Pročitano kodova: ${all.length}` });
      onCodes(all);
    } else setMsg((m) => m ?? { tone: 'info', text: 'Na slici nije pronađen barkod. Snimite bliže i oštrije ili pokušajte „Tekst (OCR)".' });
  };

  const ocr = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setMsg(null);
    setBusy('Učitavam prepoznavanje teksta…');
    try {
      const text = await ocrImageText(f, (p) => setBusy(`Prepoznajem tekst… ${p} %`));
      setBusy('Tražim serijske brojeve…');
      const r = await ocrMatchAction({ text });
      if (!r.ok) throw new Error(r.error);
      const { matched, unknown } = r.data!;
      const codes = [...matched, ...unknown];
      if (!codes.length) setMsg({ tone: 'info', text: 'U tekstu naljepnice nije pronađen serijski broj. Upišite ga ručno.' });
      else {
        setMsg({
          tone: 'ok',
          text: `OCR: ${matched.length ? `pronađeno u bazi ${matched.length}` : 'ništa iz baze'}${unknown.length ? ` · za provjeru ${unknown.length} (nisu u bazi)` : ''}`,
        });
        onCodes(codes);
      }
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof OcrUnavailableError ? e.message : `OCR nije uspio: ${e instanceof Error ? e.message : 'nepoznata greška'}. Upišite serijski broj ručno.` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-1.5" data-image-scan>
      <div className="flex flex-wrap items-center gap-2">
        <Pick multiple onFiles={barcodes} disabled={!!busy} icon={<Images className="size-3.5" />} title="Barkodovi s jedne ili više slika iz galerije">
          Galerija
        </Pick>
        <Pick camera onFiles={barcodes} disabled={!!busy} icon={<Camera className="size-3.5" />} title="Fotografirajte naljepnicu — barkodovi se pročitaju sa slike">
          Slikaj
        </Pick>
        <Pick camera onFiles={ocr} disabled={!!busy} icon={<ScanText className="size-3.5" />} title="Naljepnica bez barkoda: serijski broj iz teksta (OCR)">
          Tekst (OCR)
        </Pick>
        {busy && (
          <span className="inline-flex items-center gap-1.5 text-sm text-fg-3">
            <Loader2 className="size-3.5 animate-spin" /> {busy}
          </span>
        )}
      </div>
      {msg && <p className={cn('text-sm', msg.tone === 'bad' ? 'text-bad-strong' : msg.tone === 'ok' ? 'text-ok' : 'text-fg-3')}>{msg.text}</p>}
    </div>
  );
}
