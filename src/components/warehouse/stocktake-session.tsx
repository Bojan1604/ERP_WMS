'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { Scanner, beep, vibrate } from '@/components/scan/scanner';
import { ScanInput, useWedgeScanner } from '@/components/scan/scan-input';
import { cn } from '@/lib/cn';
import { integer } from '@/lib/format';
import { modelName, STOCKTAKE_KIND_LABEL, type StocktakeCounts, type StocktakeKind } from '@/domain/warehouse';
import { VariantPicker } from './scan-device-card';
import { removeScanAction, scanStocktakeAction, stocktakeCountsAction } from '@/app/(app)/skladiste/inventura/actions';
import type { ScanDevice } from '@/app/(app)/skladiste/skeniranje/actions';

interface Feed {
  scanId: string | null;
  serial: string;
  kind: StocktakeKind | null;
  duplicate: boolean;
  model: string | null;
  at: number;
}

const KIND_TONE: Record<StocktakeKind, 'ok' | 'warn' | 'bad'> = { found: 'ok', wrongWarehouse: 'warn', notInStock: 'warn', unknown: 'bad' };

/** Veliki brojači inventure (ažuriraju se nakon svakog skena i periodično). */
export function StocktakeCounters({ counts, className }: { counts: StocktakeCounts; className?: string }) {
  const box = (label: string, v: number, tone?: string) => (
    <div className="rounded-lg bg-panel px-3 py-2 shadow-[var(--shadow-panel)]">
      <p className="text-xs text-fg-3">{label}</p>
      <p className={cn('text-2xl font-semibold tnum', tone)}>{integer(v)}</p>
    </div>
  );
  return (
    <div className={cn('grid grid-cols-4 gap-2 max-[380px]:grid-cols-2', className)} data-counters>
      {box('Očekivano', counts.expected)}
      {box('Pronađeno', counts.found, 'text-ok')}
      {box('Nedostaje', counts.missing, counts.missing ? 'text-bad-strong' : undefined)}
      {box('Višak', counts.extra, counts.extra ? 'text-warn' : undefined)}
    </div>
  );
}

/**
 * Skeniranje u inventuri, za mobitel: kamera, ručni čitač i upis, živi brojači,
 * poništenje zadnjeg vlastitog skena. Popisi (kartice ispod) se osvježavaju s
 * odgodom, a brojači drugih skenera svakih nekoliko sekundi.
 */
export function StocktakeSession({ id, initialCounts }: { id: string; initialCounts: StocktakeCounts }) {
  const router = useRouter();
  const toast = useToast();
  const [counts, setCounts] = useState(initialCounts);
  const countsRef = useRef(initialCounts);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [busy, setBusy] = useState(0);
  const [choose, setChoose] = useState<{ code: string; items: ScanDevice[] } | null>(null);
  const refreshTimer = useRef<number>(0);

  const applyCounts = (c: StocktakeCounts) => {
    countsRef.current = c;
    setCounts(c);
  };

  // popisi na stranici se osvježavaju tek kad skeniranje malo stane
  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => router.refresh(), 1500);
  }, [router]);

  const scan = useCallback(
    async (code: string, itemId?: string) => {
      setBusy((b) => b + 1);
      try {
        const r = await scanStocktakeAction({ id, code, itemId: itemId ?? null });
        if (!r.ok) {
          beep(false);
          toast('bad', r.error);
          return;
        }
        const d = r.data!;
        applyCounts(d.counts);
        if (d.result === 'choose') {
          beep(false);
          setChoose({ code, items: d.variants as ScanDevice[] });
          return;
        }
        setChoose(null);
        const good = d.result === 'added' && d.kind === 'found';
        if (good) beep(true);
        else {
          beep(false);
          vibrate(d.result === 'duplicate' ? 60 : [90, 60, 90]);
        }
        setFeed((f) => [{ scanId: d.scanId, serial: d.serial, kind: d.kind, duplicate: d.result === 'duplicate', model: d.item ? modelName(d.item.model) : null, at: Date.now() }, ...f].slice(0, 30));
        scheduleRefresh();
      } finally {
        setBusy((b) => b - 1);
      }
    },
    [id, toast, scheduleRefresh],
  );

  const handle = useCallback((code: string) => {
    if (!document.querySelector('dialog[open]')) void scan(code);
  }, [scan]);
  useWedgeScanner(handle);

  // brojači ostalih skenera: svakih 5 s, samo dok je kartica vidljiva
  useEffect(() => {
    const t = window.setInterval(async () => {
      if (document.hidden) return;
      const r = await stocktakeCountsAction({ id });
      if (!r.ok || !r.data) return;
      const c = r.data;
      if (c.status !== 'OPEN') {
        router.refresh();
        return;
      }
      const prev = countsRef.current;
      if (c.scanned !== prev.scanned || c.found !== prev.found || c.expected !== prev.expected) {
        applyCounts(c);
        scheduleRefresh();
      }
    }, 5000);
    return () => clearInterval(t);
  }, [id, router, scheduleRefresh]);

  const lastOwn = feed.find((f) => f.scanId && !f.duplicate);
  const undo = async () => {
    if (!lastOwn?.scanId) return;
    const r = await removeScanAction({ id, scanId: lastOwn.scanId });
    if (!r.ok) return toast('bad', r.error);
    applyCounts(r.data!.counts);
    setFeed((f) => f.filter((x) => x !== lastOwn));
    toast('ok', `Poništen sken ${lastOwn.serial}.`);
    scheduleRefresh();
  };

  return (
    <div className="space-y-3">
      <StocktakeCounters counts={counts} />
      <Scanner onCode={handle} beepOnRead={false} height="h-48 sm:h-64" />
      <ScanInput onScan={handle} camera={false} size="lg" submitLabel="Dodaj" placeholder="Serijski broj (ručni unos)…" />
      {choose && (
        <VariantPicker items={choose.items} onPick={(d) => void scan(choose.code, d.id)} />
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm text-fg-3">
          {busy > 0 && <Loader2 className="size-3.5 animate-spin" />}
          Skenirano u ovoj sesiji: {feed.filter((f) => !f.duplicate).length}
        </p>
        <Button size="md" icon={<Undo2 className="size-4" />} disabled={!lastOwn} onClick={undo}>
          Poništi zadnji
        </Button>
      </div>
      {feed.length > 0 && (
        <ul className="divide-y divide-line rounded-lg bg-panel shadow-[var(--shadow-panel)]" data-feed>
          {feed.slice(0, 8).map((f) => (
            <li key={`${f.serial}-${f.at}`} className="flex items-center gap-2 px-3 py-2" data-feed-kind={f.duplicate ? 'duplicate' : f.kind}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-base">{f.serial}</p>
                {f.model && <p className="truncate text-xs text-fg-3">{f.model}</p>}
              </div>
              {f.duplicate ? (
                <Badge>Već skenirano</Badge>
              ) : f.kind ? (
                <Badge tone={KIND_TONE[f.kind]}>{STOCKTAKE_KIND_LABEL[f.kind]}</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
