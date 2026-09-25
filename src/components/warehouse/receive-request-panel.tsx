'use client';

import { Inbox } from 'lucide-react';
import { AttachmentGallery } from './attachments';
import { dateTime } from '@/lib/format';

/** Zahtjev skladištara koji se zaprima („Provjeri i zaprimi" s Odobrenja). */
export interface ReceiveRequestInfo {
  id: string;
  requestedBy: string;
  createdAt: string;
  warehouseId: string;
  note: string | null;
  returning: Array<{ id: string; serial: string; status: string }>;
  photos: Array<{ id: string; code: string | null; mime: string; fileName: string; size: number }>;
}

/** Podaci zahtjeva skladištara iznad obrasca: tko je poslao, što se vraća i slike naljepnica. */
export function RequestPanel({ request }: { request: ReceiveRequestInfo }) {
  return (
    <div className="mb-4 rounded-lg border-l-4 border-l-warn bg-warn-soft/60 px-4 py-3" data-receive-request={request.id}>
      <p className="flex items-start gap-2 text-base">
        <Inbox className="mt-1 size-4 shrink-0 text-warn" />
        <span className="min-w-0">
          Zaprimanje po zahtjevu <b>{request.requestedBy}</b> · {dateTime(request.createdAt)}
        </span>
      </p>
      <p className="mt-1 text-sm text-fg-2">
        Provjerite serijske brojeve i slike, odaberite model i zaprimite. Zahtjev se odobrava zajedno sa zaprimanjem
        {request.returning.length > 0 && <>, a {request.returning.length} poznatih uređaja vraća se na odabrano skladište</>}.
      </p>
      {request.note && <p className="mt-1 text-sm text-fg-2">Napomena: {request.note}</p>}
      {request.returning.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {request.returning.map((i) => (
            <span key={i.id} className="rounded bg-panel px-1.5 py-0.5 font-mono text-xs" title={`Sada: ${i.status}`}>
              {i.serial} <span className="font-sans text-fg-3">· {i.status}</span>
            </span>
          ))}
        </div>
      )}
      {request.photos.length > 0 && (
        <AttachmentGallery className="mt-3" items={request.photos.map((p) => ({ ...p, label: p.code, caption: p.code ? `Serijski: ${p.code}` : 'Općenita slika' }))} />
      )}
    </div>
  );
}
