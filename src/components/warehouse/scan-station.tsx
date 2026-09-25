'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { History, ListChecks, Loader2, PackagePlus, ScanLine, SearchX, Send } from 'lucide-react';
import { Button, buttonClass } from '@/components/ui/button';
import { Scanner, beep, vibrate } from '@/components/scan/scanner';
import { ScanInput, useWedgeScanner } from '@/components/scan/scan-input';
import { ImageScan } from '@/components/scan/image-scan';
import { cn } from '@/lib/cn';
import { ScanBatch, entryDevice, type BatchEntry } from './scan-batch';
import { ScanDeviceCard, VariantPicker } from './scan-device-card';
import { ReceiveRequestDialog, receiveRequestBtn } from './receive-request-dialog';
import type { Perms, WarehouseOptions } from './dialogs';
import { lookupScanAction, refreshScanAction, type LookupResult, type ScanDevice } from '@/app/(app)/skladiste/skeniranje/actions';

type Mode = 'single' | 'batch';
const MODE_KEY = 'scan.mode';
const BATCH_KEY = 'scan.batch';

const store = {
  get<T>(k: string, storage: 'local' | 'session'): T | null {
    try {
      const v = (storage === 'local' ? localStorage : sessionStorage).getItem(k);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown, storage: 'local' | 'session') {
    try {
      (storage === 'local' ? localStorage : sessionStorage).setItem(k, JSON.stringify(v));
    } catch {
      /* privatni način — stanje se samo ne pamti */
    }
  },
};

function feedback(found: boolean) {
  if (found) beep(true);
  else {
    beep(false);
    vibrate([90, 60, 90]);
  }
}

/**
 * Skladišna radna stanica: kamera, ručni čitač ili upis → uređaj. Pojedinačni
 * način prikazuje karticu s brzim radnjama, serijski način skuplja kodove u
 * popis za jednu skupnu radnju.
 */
export function ScanStation({ perms, options }: { perms: Perms; options: WarehouseOptions }) {
  const [mode, setModeState] = useState<Mode>('single');
  const modeRef = useRef<Mode>('single');
  const [current, setCurrent] = useState<(LookupResult & { chosen: string | null }) | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [batch, setBatchState] = useState<BatchEntry[]>([]);
  const batchRef = useRef<BatchEntry[]>([]);
  const resultRef = useRef<HTMLDivElement>(null);
  const [requestCode, setRequestCode] = useState<string | null>(null);

  const setBatch = useCallback((fn: (prev: BatchEntry[]) => BatchEntry[]) => {
    batchRef.current = fn(batchRef.current);
    setBatchState(batchRef.current);
    store.set(BATCH_KEY, batchRef.current.filter((e) => e.status !== 'loading'), 'session');
  }, []);

  const setMode = (m: Mode) => {
    modeRef.current = m;
    setModeState(m);
    store.set(MODE_KEY, m, 'local');
  };

  useEffect(() => {
    // ?nacin=serijski (plutajući gumb u popisu skladišta) ima prednost pred zapamćenim načinom
    const q = new URLSearchParams(window.location.search).get('nacin');
    const m = q === 'serijski' ? 'batch' : q === 'pojedinacno' ? 'single' : store.get<Mode>(MODE_KEY, 'local');
    if (m === 'batch' || m === 'single') {
      modeRef.current = m;
      setModeState(m);
    }
    const saved = store.get<BatchEntry[]>(BATCH_KEY, 'session');
    if (Array.isArray(saved)) {
      batchRef.current = saved;
      setBatchState(saved);
    }
  }, []);

  const lookup = async (code: string) => {
    const r = await lookupScanAction({ code });
    if (!r.ok) throw new Error(r.error);
    return r.data!;
  };

  const scanSingle = async (code: string) => {
    setLoading(code);
    setError(null);
    try {
      const r = await lookup(code);
      feedback(r.items.length > 0);
      setCurrent({ ...r, chosen: r.items.length === 1 ? r.items[0].id : null });
      // na mobitelu je rezultat ispod kamere — pomakni ga u vidno polje
      if (window.matchMedia('(max-width: 1023px)').matches) requestAnimationFrame(() => resultRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      setRecent((v) => [code, ...v.filter((x) => x !== code)].slice(0, 12));
    } catch (e) {
      feedback(false);
      setError(e instanceof Error ? e.message : 'Greška pri provjeri koda.');
    } finally {
      setLoading(null);
    }
  };

  const scanBatch = async (code: string) => {
    const existing = batchRef.current.find((e) => e.code === code);
    if (existing) {
      feedback(false);
      setBatch((v) => [{ ...existing, repeats: existing.repeats + 1, at: Date.now() }, ...v.filter((e) => e.code !== code)]);
      return;
    }
    setBatch((v) => [{ code, status: 'loading', items: [], chosen: null, at: Date.now(), repeats: 0 }, ...v]);
    try {
      const r = await lookup(code);
      // isti uređaj pod drugim oblikom koda (npr. „SN: X" i „X") — to je ponovni sken
      const dev = r.items.length === 1 ? r.items[0] : null;
      const twin = dev && batchRef.current.find((e) => e.code !== code && entryDevice(e)?.id === dev.id);
      if (twin) {
        feedback(false);
        setBatch((v) => [{ ...twin, repeats: twin.repeats + 1, at: Date.now() }, ...v.filter((e) => e.code !== code && e.code !== twin.code)]);
        return;
      }
      feedback(r.items.length > 0);
      const status: BatchEntry['status'] = r.items.length === 0 ? 'none' : r.items.length === 1 ? 'found' : 'multi';
      setBatch((v) => v.map((e) => (e.code === code ? { ...e, status, items: r.items } : e)));
    } catch {
      feedback(false);
      setBatch((v) => v.map((e) => (e.code === code ? { ...e, status: 'error' } : e)));
    }
  };

  const handle = useCallback((raw: string) => {
    const code = raw.trim();
    // dok je otvoren dijalog radnje, novi sken ne smije zamijeniti uređaj ispod njega
    if (!code || document.querySelector('dialog[open]')) return;
    if (modeRef.current === 'batch') void scanBatch(code);
    else void scanSingle(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useWedgeScanner(handle);

  const refreshSingle = async () => {
    if (!current) return;
    const r = await refreshScanAction({ ids: current.items.map((i) => i.id) });
    if (r.ok && r.data) setCurrent({ ...current, items: current.items.map((i) => r.data!.find((x) => x.id === i.id) ?? i) });
  };

  const refreshBatch = async () => {
    const ids = batchRef.current.flatMap((e) => e.items.map((i) => i.id));
    if (!ids.length) return;
    const r = await refreshScanAction({ ids });
    if (!r.ok || !r.data) return;
    const m = new Map(r.data.map((d) => [d.id, d]));
    setBatch((v) => v.map((e) => ({ ...e, items: e.items.map((i) => m.get(i.id) ?? i) })));
  };

  const chosen: ScanDevice | null = current?.chosen ? current.items.find((i) => i.id === current.chosen) ?? null : null;

  return (
    <div className="mx-auto max-w-6xl lg:grid lg:grid-cols-[26rem_minmax(0,1fr)] lg:items-start lg:gap-5">
      <div className="space-y-3 lg:sticky lg:top-0">
        <div className="grid grid-cols-2 rounded-lg bg-muted p-1" role="tablist" aria-label="Način skeniranja">
          {(
            [
              ['single', 'Pojedinačno', ScanLine],
              ['batch', `Serijski način${batch.length ? ` (${batch.length})` : ''}`, ListChecks],
            ] as const
          ).map(([m, label, Icon]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn('flex h-10 items-center justify-center gap-1.5 rounded-md text-base', mode === m ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-3')}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>
        <Scanner onCode={handle} beepOnRead={false} height="h-44 sm:h-64" />
        <ScanInput onScan={handle} camera={false} size="lg" submitLabel="Traži" placeholder="Upišite ili očitajte čitačem…" />
        <ImageScan
          onCodes={(codes) => {
            // više kodova sa slike ide u serijski popis
            if (codes.length > 1 && modeRef.current === 'single') setMode('batch');
            for (const c of codes) handle(c);
          }}
        />
        <p className="text-xs text-fg-3">
          Ručni čitač barkodova radi uvijek — samo skenirajte. Čita se serijski broj, GS1 kod (AI 21) i QR s naljepnice ovog programa.
        </p>
      </div>

      <div className="mt-4 min-w-0 lg:mt-0">
        {mode === 'batch' ? (
          <ScanBatch
            entries={batch}
            perms={perms}
            options={options}
            onRemove={(code) => setBatch((v) => v.filter((e) => e.code !== code))}
            onRemoveMany={(codes) => setBatch((v) => v.filter((e) => !codes.includes(e.code)))}
            onChoose={(code, id) => setBatch((v) => v.map((e) => (e.code === code ? { ...e, chosen: id } : e)))}
            onClear={() => setBatch(() => [])}
            onChanged={refreshBatch}
          />
        ) : (
          <div className="scroll-mt-3 space-y-3" ref={resultRef}>
            {loading ? (
              <div className="flex items-center gap-2 rounded-lg bg-panel px-4 py-6 text-base text-fg-3 shadow-[var(--shadow-panel)]">
                <Loader2 className="size-5 animate-spin" /> Tražim <span className="font-mono">{loading}</span>…
              </div>
            ) : error ? (
              <div className="rounded-lg bg-bad-soft px-4 py-3 text-base text-bad-strong">{error}</div>
            ) : !current ? (
              <div className="rounded-lg bg-panel px-4 py-10 text-center text-sm text-fg-3 shadow-[var(--shadow-panel)]">
                Skenirajte naljepnicu ili upišite serijski broj — ovdje se prikazuje uređaj s radnjama koje su mu dostupne.
              </div>
            ) : chosen ? (
              <ScanDeviceCard device={chosen} perms={perms} options={options} onChanged={refreshSingle} via={current.via} />
            ) : current.items.length > 1 ? (
              <VariantPicker items={current.items} onPick={(d) => setCurrent({ ...current, chosen: d.id })} />
            ) : (
              <div className="rounded-lg border-l-4 border-l-bad-strong bg-panel px-4 py-4 shadow-[var(--shadow-panel)]" data-not-found>
                <p className="flex items-center gap-2 text-md font-semibold">
                  <SearchX className="size-5 text-bad-strong" /> Nema uređaja
                </p>
                <p className="mt-1 break-all text-base">
                  Kod <b className="font-mono">{current.code}</b> ne odgovara nijednom serijskom broju.
                </p>
                {perms.canEdit && (
                  <Link prefetch={false} href={`/skladiste/zaprimanje?serijski=${encodeURIComponent(current.code)}`} className={buttonClass('primary', 'md', 'mt-3')}>
                    <PackagePlus className="size-4" />
                    Zaprimi kao novi uređaj
                  </Link>
                )}
                {!perms.canEdit && perms.canOps && (
                  <Button className={cn(receiveRequestBtn, 'mt-3')} icon={<Send className="size-4" />} onClick={() => setRequestCode(current.code)}>
                    Pošalji na zaprimanje
                  </Button>
                )}
                {requestCode === current.code && (
                  <ReceiveRequestDialog
                    unknown={[current.code]}
                    returning={[]}
                    warehouses={options.warehouses}
                    onClose={() => setRequestCode(null)}
                    onSent={() => setCurrent(null)}
                  />
                )}
              </div>
            )}
            {recent.length > 1 && (
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-sm text-fg-3">
                  <History className="size-3.5" /> Nedavno
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {recent.slice(1).map((c) => (
                    <button key={c} type="button" onClick={() => void scanSingle(c)} className="rounded-md bg-panel px-2 py-1 font-mono text-sm shadow-[var(--shadow-panel)] hover:bg-muted">
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
