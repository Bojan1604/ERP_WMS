'use client';

import { useState, type ReactNode } from 'react';
import { Download, ExternalLink, FileText, Printer } from 'lucide-react';
import { Button, buttonClass, type ButtonSize, type ButtonVariant } from './button';
import { Dialog } from './dialog';
import { PDF_KIND_LABEL, type PdfKind } from '@/domain/documents';

/** Poveznica na PDF dokumenta (GET /api/pdf/[kind]/[id]); `download` = preuzimanje. */
export const pdfUrl = (kind: PdfKind, id: string, download = false) => `/api/pdf/${kind}/${encodeURIComponent(id)}${download ? '?preuzmi' : ''}`;

/**
 * Gumb „PDF": otvara pregled PDF-a dokumenta u dijalogu (iframe) s gumbima
 * Preuzmi / Ispis / Otvori. `extra` dodaje radnje u podnožje (npr. SendEmailButton).
 * Područje A ga dorađuje (A2); potpis ostaje.
 */
export function PdfButton({
  kind,
  id,
  label = 'PDF',
  title,
  variant = 'secondary',
  size = 'md',
  extra,
}: {
  kind: PdfKind;
  id: string;
  label?: ReactNode;
  /** Naslov dijaloga (zadano: vrsta dokumenta). */
  title?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const src = pdfUrl(kind, id);
  const print = () => {
    const f = document.getElementById(`pdf-${kind}-${id}`) as HTMLIFrameElement | null;
    try {
      f?.contentWindow?.focus();
      f?.contentWindow?.print();
    } catch {
      window.open(src, '_blank', 'noopener');
    }
  };
  return (
    <>
      <Button variant={variant} size={size} icon={<FileText className="size-4" />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="xl"
        title={title ?? PDF_KIND_LABEL[kind]}
        footer={
          <div className="flex w-full flex-wrap items-center gap-2">
            {extra}
            <span className="flex-1" />
            <a href={pdfUrl(kind, id, true)} className={buttonClass('secondary', 'sm')}>
              <Download className="size-3.5" /> Spremi PDF
            </a>
            <Button size="sm" icon={<Printer className="size-3.5" />} onClick={print}>
              Ispis
            </Button>
            <a href={src} target="_blank" rel="noreferrer" className={buttonClass('secondary', 'sm')}>
              <ExternalLink className="size-3.5" /> Otvori
            </a>
          </div>
        }
      >
        <iframe id={`pdf-${kind}-${id}`} src={src} title={typeof title === 'string' ? title : PDF_KIND_LABEL[kind]} className="h-[72dvh] w-full rounded-md border border-line bg-muted" />
      </Dialog>
    </>
  );
}
