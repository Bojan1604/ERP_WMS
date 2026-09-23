'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, type Option } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { FormError, useAction } from '@/components/ui/action';
import { LabelPhotos, PhotoSection, type PhotoTarget, type PickedPhoto } from './label-photos';
import { photoForm } from './image-tools';
import { ATTACHMENT_MAX_PER_REQUEST } from '@/domain/attachments';
import { sendReceiveRequestAction } from '@/app/(app)/skladiste/skeniranje/actions';

export interface ReturningDevice {
  id: string;
  serial: string;
  statusName: string;
}

/** Žuti gumb „Pošalji na zaprimanje" (razina operativno — skladištar ne zaprima sam). */
export const receiveRequestBtn = 'border-0 bg-amber-400 text-amber-950 hover:bg-amber-300';

/**
 * Zahtjev za zaprimanje: nepoznati serijski brojevi i poznati uređaji izvan
 * skladišta idu administratoru, uz neobavezne slike naljepnica.
 */
export function ReceiveRequestDialog({
  unknown,
  returning,
  warehouses,
  onClose,
  onSent,
}: {
  unknown: string[];
  returning: ReturningDevice[];
  warehouses: Option[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const { run, pending, error } = useAction(sendReceiveRequestAction);
  const targets: PhotoTarget[] = [
    ...unknown.map((s) => ({ key: s, serial: s, hint: 'novi' })),
    ...returning.map((d) => ({ key: d.id, serial: d.serial, hint: d.statusName })),
  ];
  const total = unknown.length + returning.length;

  const submit = async () => {
    const data = { serials: unknown, returning: returning.map((d) => d.id), warehouseId, note };
    const r = await run(photos.length ? photoForm(data, photos) : data);
    if (r.ok) {
      onClose();
      onSent();
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Pošalji na zaprimanje"
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button
            className={receiveRequestBtn}
            icon={<Send className="size-4" />}
            loading={pending}
            disabled={!warehouseId || !total || photos.some((p) => p.reading)}
            onClick={submit}
          >
            Pošalji ({total})
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice tone="info">Administrator provjerava i zaprima robu. Novi uređaji nastaju tek kad on potvrdi zaprimanje.</Notice>
        {unknown.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium">Novi serijski brojevi ({unknown.length})</p>
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto scroll-slim">
              {unknown.map((s) => (
                <span key={s} className="rounded bg-warn-soft px-1.5 py-0.5 font-mono text-xs text-warn">
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}
        {returning.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium">Povrat na skladište ({returning.length})</p>
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto scroll-slim">
              {returning.map((d) => (
                <span key={d.id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {d.serial} <span className="font-sans text-fg-3">· {d.statusName}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        <Field label="Skladište" required>
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} options={warehouses} />
        </Field>
        <Field label="Napomena">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="npr. dobavljač, otpremnica, stanje robe…" />
        </Field>
        <PhotoSection title="Slike naljepnica (neobavezno)" hint="Slika se pročita i poveže sa serijskim brojem; administrator je vidi pri zaprimanju.">
          <LabelPhotos targets={targets} photos={photos} setPhotos={setPhotos} allowUnlinked max={ATTACHMENT_MAX_PER_REQUEST} />
        </PhotoSection>
        <FormError error={error} />
      </div>
    </Dialog>
  );
}
