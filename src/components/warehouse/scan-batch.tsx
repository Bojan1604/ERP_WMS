'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, PackagePlus, Send, X } from 'lucide-react';
import { Badge, COLOR_TONE } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { modelName, STATE_LABEL, type StateKind } from '@/domain/warehouse';
import { RECEIVE_PREFILL_KEY } from '@/components/scan/core';
import { BACK_TO_STOCK_STATES } from '@/domain/receive-request';
import { ReceiveRequestDialog, receiveRequestBtn } from './receive-request-dialog';
import { ScanActions } from './scan-actions';
import { stateTone, toTarget, VariantPicker } from './scan-device-card';
import type { Perms, WarehouseOptions } from './dialogs';
import type { ScanDevice } from '@/app/(app)/skladiste/skeniranje/actions';

export interface BatchEntry {
  code: string;
  status: 'loading' | 'found' | 'multi' | 'none' | 'error';
  items: ScanDevice[];
  /** Odabrani uređaj (kod duplikata serijskog). */
  chosen: string | null;
  at: number;
  /** Koliko je puta kod ponovno skeniran (za naglasak „već u popisu"). */
  repeats: number;
}

export const entryDevice = (e: BatchEntry): ScanDevice | null =>
  e.status === 'found' ? e.items[0] : e.status === 'multi' && e.chosen ? e.items.find((i) => i.id === e.chosen) ?? null : null;

/** Popis skeniranih u serijskom načinu i traka skupne radnje pri dnu. */
export function ScanBatch({
  entries,
  perms,
  options,
  onRemove,
  onRemoveMany,
  onChoose,
  onClear,
  onChanged,
}: {
  entries: BatchEntry[];
  perms: Perms;
  options: WarehouseOptions;
  onRemove: (code: string) => void;
  /** Uklanja poslane kodove (nakon zahtjeva za zaprimanje). */
  onRemoveMany: (codes: string[]) => void;
  onChoose: (code: string, id: string) => void;
  onClear: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const devices = entries.map(entryDevice).filter((d): d is ScanDevice => !!d);
  const unknown = entries.filter((e) => e.status === 'none').map((e) => e.code);
  const [requestOpen, setRequestOpen] = useState(false);
  // skladištar (operativno) ne zaprima sam — nepoznate i uređaje izvan skladišta šalje administratoru
  const canRequest = perms.canOps && !perms.canEdit;
  const back = devices.filter((d) => BACK_TO_STOCK_STATES.includes(d.state as StateKind));
  const sentCodes = () => {
    const ids = new Set(back.map((d) => d.id));
    return entries.filter((e) => e.status === 'none' || (entryDevice(e) && ids.has(entryDevice(e)!.id))).map((e) => e.code);
  };
  const byState = new Map<string, number>();
  for (const d of devices) byState.set(d.state, (byState.get(d.state) ?? 0) + 1);

  const receiveUnknown = () => {
    try {
      sessionStorage.setItem(RECEIVE_PREFILL_KEY, JSON.stringify(unknown));
      router.push('/skladiste/zaprimanje');
    } catch {
      router.push(`/skladiste/zaprimanje?serijski=${encodeURIComponent(unknown.slice(0, 200).join(','))}`);
    }
  };

  if (!entries.length) {
    return (
      <div className="rounded-lg bg-panel px-4 py-10 text-center text-sm text-fg-3 shadow-[var(--shadow-panel)]">
        Skenirajte uređaje jedan za drugim — skupljaju se u popis, a zatim jednom radnjom obradite sve pronađene.
      </div>
    );
  }

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-sm">
        <Badge tone="ok">Pronađeno {devices.length}</Badge>
        {unknown.length > 0 && <Badge tone="bad">Nepoznato {unknown.length}</Badge>}
        {[...byState].map(([s, n]) => (
          <Badge key={s}>
            {STATE_LABEL[s as StateKind]} {n}
          </Badge>
        ))}
        <button type="button" onClick={onClear} className="ml-auto text-sm text-fg-3 hover:text-fg">
          Očisti popis
        </button>
      </div>

      <ul className="space-y-2" data-batch-list>
        {entries.map((e) => {
          const d = entryDevice(e);
          return (
            <li
              key={e.code}
              data-batch-entry={e.code}
              data-status={e.status}
              className={cn(
                'rounded-lg border-l-4 bg-panel shadow-[var(--shadow-panel)] transition-colors',
                d ? stateTone(d.state) : e.status === 'none' ? 'border-l-bad-strong' : 'border-l-line-strong',
                e.repeats > 0 && 'ring-2 ring-warn/50',
              )}
            >
              <div className="flex items-center gap-3 px-3 py-2.5">
                <span className="shrink-0">
                  {e.status === 'loading' ? (
                    <Loader2 className="size-5 animate-spin text-fg-3" />
                  ) : d ? (
                    <CheckCircle2 className="size-5 text-ok" />
                  ) : e.status === 'multi' ? (
                    <HelpCircle className="size-5 text-warn" />
                  ) : (
                    <AlertTriangle className="size-5 text-bad-strong" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-base font-semibold">
                    {d ? (
                      <Link prefetch={false} href={`/skladiste/${d.id}`} className="hover:underline">
                        {d.serial}
                      </Link>
                    ) : (
                      e.code
                    )}
                    {d?.dupNote && <span className="ml-1 text-xs font-normal text-warn">({d.dupNote})</span>}
                  </p>
                  <p className="truncate text-sm text-fg-3">
                    {d
                      ? [modelName(d.model), d.warehouse?.name, d.partner?.name].filter(Boolean).join(' · ')
                      : e.status === 'none'
                        ? 'Nema u bazi'
                        : e.status === 'multi'
                          ? `${e.items.length} uređaja s istim serijskim — odaberite`
                          : e.status === 'error'
                            ? 'Greška pri provjeri — pokušajte ponovno'
                            : 'Provjera…'}
                    {e.repeats > 0 && <span className="text-warn"> · već u popisu (×{e.repeats + 1})</span>}
                  </p>
                </div>
                {d && <Badge tone={COLOR_TONE[d.status.color] ?? 'neutral'}>{d.status.name}</Badge>}
                <button type="button" onClick={() => onRemove(e.code)} className="grid size-9 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-muted" aria-label={`Ukloni ${e.code}`}>
                  <X className="size-4" />
                </button>
              </div>
              {e.status === 'multi' && !e.chosen && (
                <div className="px-3 pb-3">
                  <VariantPicker items={e.items} onPick={(x) => onChoose(e.code, x.id)} />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* ljepljiva traka iznad donje navigacije mobitela */}
      <div className="no-print sticky bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-30 mt-3 rounded-lg bg-nav px-3 py-2.5 text-nav-fg shadow-[var(--shadow-pop)] lg:bottom-3" data-batch-bar>
        <p className="mb-2 text-sm">
          Radnja za <b className="text-nav-fg-strong">{devices.length}</b> pronađenih
          {unknown.length > 0 && <> · {unknown.length} nepoznatih</>}
          <span className="text-nav-fg-2 sm:hidden"> · povucite →</span>
        </p>
        {/* na mobitelu jedan red koji se povlači vodoravno, da traka ne prekrije popis */}
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5 scroll-slim max-sm:[&>*]:shrink-0 sm:flex-wrap">
          <ScanActions targets={devices.map(toTarget)} perms={perms} options={options} onDone={onChanged} tone="dark" bulk />
          {perms.canEdit && unknown.length > 0 && (
            <Button variant="primary" icon={<PackagePlus className="size-4" />} onClick={receiveUnknown}>
              Zaprimi nepoznate ({unknown.length})
            </Button>
          )}
          {canRequest && unknown.length + back.length > 0 && (
            <Button className={receiveRequestBtn} icon={<Send className="size-4" />} onClick={() => setRequestOpen(true)} data-receive-request-btn>
              Pošalji na zaprimanje ({unknown.length + back.length})
            </Button>
          )}
        </div>
      </div>
      {requestOpen && (
        <ReceiveRequestDialog
          unknown={unknown}
          returning={back.map((d) => ({ id: d.id, serial: d.serial, statusName: d.status.name }))}
          warehouses={options.warehouses}
          onClose={() => setRequestOpen(false)}
          onSent={() => onRemoveMany(sentCodes())}
        />
      )}
    </>
  );
}
