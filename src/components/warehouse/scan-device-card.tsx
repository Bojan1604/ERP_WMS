'use client';

import Link from 'next/link';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { Badge, COLOR_TONE } from '@/components/ui/misc';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { modelName, STATE_LABEL, type StateKind } from '@/domain/warehouse';
import { ScanActions } from './scan-actions';
import type { Perms, WarehouseOptions } from './dialogs';
import type { ScanDevice } from '@/app/(app)/skladiste/skeniranje/actions';

export const toTarget = (d: ScanDevice) => ({ id: d.id, state: d.state as StateKind, onContract: !!d.contractItem, cost: d.cost ?? null });

/** Boja ruba po stanju: zeleno na skladištu, žuto vani / u pokretu, crveno otpisan. */
export function stateTone(state: string) {
  if (state === 'IN_STOCK') return 'border-l-ok';
  if (state === 'WRITTEN_OFF') return 'border-l-bad-strong';
  if (state === 'SERVICE') return 'border-l-bad';
  return 'border-l-warn';
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/70 py-1.5 last:border-0">
      <dt className="shrink-0 text-sm text-fg-3">{label}</dt>
      <dd className="min-w-0 text-right">{children ?? <span className="text-fg-4">—</span>}</dd>
    </div>
  );
}

/** Kartica skeniranog uređaja s brzim radnjama prema stanju i pravima. */
export function ScanDeviceCard({
  device,
  perms,
  options,
  onChanged,
  via,
}: {
  device: ScanDevice;
  perms: Perms;
  options: WarehouseOptions;
  onChanged: () => void;
  via?: string | null;
}) {
  const d = device;
  return (
    <section className={cn('rounded-lg border-l-4 bg-panel shadow-[var(--shadow-panel)]', stateTone(d.state))} data-device-card={d.serial}>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="break-all font-mono text-lg font-semibold leading-tight">
            {d.serial}
            {d.dupNote && <span className="ml-1.5 text-sm font-normal text-warn">({d.dupNote})</span>}
          </p>
          <p className="text-base text-fg-2">{modelName(d.model)}</p>
          {via && via !== 'exact' && <p className="text-xs text-fg-3">{via === 'link' ? 'Pročitano iz QR koda naljepnice' : via === 'partial' ? 'Upareno kao dio serijskog broja' : 'Upareno po drugom obliku koda'}</p>}
        </div>
        <Badge tone={COLOR_TONE[d.status.color] ?? 'neutral'} className="text-sm">
          {d.status.name}
        </Badge>
      </header>
      <dl className="px-4 py-1.5">
        <Row label="Stanje">{STATE_LABEL[d.state as StateKind]}</Row>
        <Row label="Skladište">{d.warehouse?.name}</Row>
        <Row label="Klijent">
          {d.partner ? (
            <Link prefetch={false} href={`/partneri/${d.partner.id}`} className="link">
              {d.partner.name}
            </Link>
          ) : null}
        </Row>
        <Row label="Ugovor">
          {d.contractItem ? (
            <Link prefetch={false} href={`/najam/ugovori/${d.contractItem.contract.id}`} className="link">
              {d.contractItem.contract.number}
            </Link>
          ) : null}
        </Row>
      </dl>
      <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3 [&>*]:max-sm:flex-1 [&>*]:max-sm:basis-[calc(50%-0.25rem)]">
        <ScanActions targets={[toTarget(d)]} perms={perms} options={options} onDone={onChanged} />
        <Link prefetch={false} href={`/skladiste/${d.id}`} className={buttonClass('ghost')}>
          <ExternalLink className="size-4" />
          Otvori karticu
        </Link>
      </div>
    </section>
  );
}

/** Izbor među uređajima s istim serijskim brojem (razlikovna napomena). */
export function VariantPicker({ items, onPick }: { items: ScanDevice[]; onPick: (d: ScanDevice) => void }) {
  return (
    <div className="rounded-lg bg-panel shadow-[var(--shadow-panel)]">
      <p className="border-b border-line px-4 py-2.5 text-base">
        Serijski broj <b className="font-mono">{items[0]?.serial}</b> ima {items.length} uređaja — odaberite koji je skeniran:
      </p>
      <ul className="divide-y divide-line">
        {items.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => onPick(d)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{d.dupNote || 'bez napomene'}</p>
                <p className="truncate text-sm text-fg-3">
                  {modelName(d.model)} · {d.warehouse?.name ?? d.partner?.name ?? '—'}
                </p>
              </div>
              <Badge tone={COLOR_TONE[d.status.color] ?? 'neutral'}>{d.status.name}</Badge>
              <ChevronRight className="size-4 text-fg-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
