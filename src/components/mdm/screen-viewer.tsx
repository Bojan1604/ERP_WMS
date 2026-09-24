'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Download, Loader2, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, Empty } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { dateTime } from '@/lib/format';
import { sendCommandAction } from '@/app/(app)/mdm/uredaji/actions';
import { ago } from './common';

interface Shot {
  id: string;
  at: string;
  name: string;
  size: number;
}
interface State {
  pending: { id: string; status: string; createdAt: string } | null;
  uploads: Shot[];
}

const POLL_MS = 3000;
const LIVE_MS = 5000;

/**
 * „Remote screen": snimka zaslona na zahtjev. Dok naredba čeka, prikaz se
 * osvježava svake 3 s; „Uživo" traži novu snimku svakih ~5 s dok je kartica
 * vidljiva (skrivena kartica ne troši uređaj ni mrežu).
 */
export function ScreenViewer({ deviceId, initial, canRequest, enrolled }: { deviceId: string; initial: State; canRequest: boolean; enrolled: boolean }) {
  const [state, setState] = useState<State>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(initial.pending ? Date.now() : null);
  const [requesting, setRequesting] = useState(false);
  const [visible, setVisible] = useState(true);
  const toast = useToast();
  const lastLiveReq = useRef(0);
  // relativno vrijeme tek nakon hidracije (poslužitelj i preglednik imaju različit „sada")
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  const rel = (at: string) => (now ? ago(at, now) : dateTime(at));

  const load = useCallback(async () => {
    const r = await fetch(`/api/mdm/uploads?device=${encodeURIComponent(deviceId)}&kind=SCREENSHOT`, { cache: 'no-store' });
    if (!r.ok) return null;
    const data = (await r.json()) as State;
    setState(data);
    return data;
  }, [deviceId]);

  const request = useCallback(
    async (quiet: boolean) => {
      setRequesting(true);
      const res = await sendCommandAction({ ids: [deviceId], type: 'SCREENSHOT' });
      setRequesting(false);
      if (!res.ok) {
        toast('bad', res.error);
        setLive(false);
        return;
      }
      if (!quiet) toast('ok', 'Zahtjev za snimku poslan — čekam uređaj…');
      setWaitingSince(Date.now());
      load();
    },
    [deviceId, load, toast],
  );

  // vidljivost kartice
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // čekanje nove snimke: osvježavanje svake 3 s (najviše 2 min bez uživo načina)
  useEffect(() => {
    if (!visible || (!waitingSince && !live)) return;
    const t = setInterval(async () => {
      const data = await load();
      if (!data || live) return;
      const newest = data.uploads[0] ? new Date(data.uploads[0].at).getTime() : 0;
      if ((!data.pending && newest >= (waitingSince ?? 0) - 5000) || Date.now() - (waitingSince ?? 0) > 120_000) setWaitingSince(null);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [visible, waitingSince, live, load]);

  // uživo: nova snimka svakih ~5 s dok prethodna ne stigne (naredba se ne udvostručuje)
  useEffect(() => {
    if (!live || !visible) return;
    const tick = () => {
      if (Date.now() - lastLiveReq.current < LIVE_MS - 200) return;
      lastLiveReq.current = Date.now();
      request(true);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [live, visible, request]);

  const shots = state.uploads;
  const current = shots.find((s) => s.id === selected) ?? shots[0] ?? null;
  const waiting = !!state.pending || !!waitingSince;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {canRequest && enrolled && (
          <>
            <Button variant="primary" icon={<Camera className="size-4" />} loading={requesting && !live} onClick={() => request(false)} disabled={live}>
              Snimi zaslon
            </Button>
            <Button variant={live ? 'danger' : 'secondary'} icon={live ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => setLive((v) => !v)}>
              {live ? 'Zaustavi uživo' : 'Uživo'}
            </Button>
          </>
        )}
        {waiting && (
          <span className="inline-flex items-center gap-1.5 text-sm text-fg-3">
            <Loader2 className="size-3.5 animate-spin" />
            {live ? (visible ? 'Uživo — nova snimka svakih ~5 s' : 'Uživo pauzirano (kartica nije vidljiva)') : 'Čekam snimku s uređaja…'}
          </span>
        )}
        {!enrolled && <span className="text-sm text-fg-3">Snimke se mogu tražiti samo od upisanog uređaja.</span>}
      </div>

      {current ? (
        <Card
          padded={false}
          title={
            <span className="text-sm font-normal text-fg-2">
              {dateTime(current.at)} {now && <span className="text-fg-3">({rel(current.at)})</span>}
            </span>
          }
          actions={
            <a href={`/api/mdm/uploads/${current.id}?preuzmi`} className="inline-flex items-center gap-1 text-sm link">
              <Download className="size-4" /> Preuzmi
            </a>
          }
        >
          <div className="grid place-items-center bg-muted p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/mdm/uploads/${current.id}`} alt={`Snimka zaslona ${dateTime(current.at)}`} className="max-h-[70vh] w-auto max-w-full rounded shadow" />
          </div>
        </Card>
      ) : (
        <Card>
          <Empty icon={<Camera className="size-5" />} title="Još nema snimki zaslona" description="Zatražite snimku — uređaj je šalje pri sljedećem javljanju." />
        </Card>
      )}

      {shots.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1 scroll-slim">
          {shots.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelected(s.id)}
              className={cn('shrink-0 overflow-hidden rounded-md border-2 bg-muted', current?.id === s.id ? 'border-brand' : 'border-transparent')}
              title={dateTime(s.at)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/mdm/uploads/${s.id}`} alt="" loading="lazy" className="h-20 w-auto" />
              <span className="block px-1 py-0.5 text-xs text-fg-3">{rel(s.at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
