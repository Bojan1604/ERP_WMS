'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Flashlight, FlashlightOff, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { cameraErrorMessage, cameraSupport, createDedupe, NATIVE_FORMATS, type CameraSupport } from './core';

/*
 * Skener kamerom. Prvo ugrađeni BarcodeDetector preglednika (Android Chrome —
 * hardverski, brz), inače @zxing/browser (iOS Safari, Firefox). Neprekidno
 * čitanje, stražnja kamera, bljeskalica kad je kamera podržava, zvuk i
 * vibracija pri očitanju, isti kod unutar 2 s se ne ponavlja.
 */

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

type Phase = 'idle' | 'starting' | 'running' | 'error';

const PREF_KEY = 'scan.camera';

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
}
function writePref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* privatni način — nije bitno */
  }
}

let audio: AudioContext | null = null;
/** Kratki „bip" (Web Audio) — AudioContext se otvara na dodir korisnika (iOS). */
export function beep(ok = true) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === 'suspended') void audio.resume();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 1650 : 330;
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.08 : 0.25));
  } catch {
    /* bez zvuka */
  }
}

export function vibrate(ms: number | number[] = 40) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* nije podržano */
  }
}

export function Scanner({
  onCode,
  autoStart,
  paused,
  className,
  height = 'h-56',
  beepOnRead = true,
}: {
  /** Poziva se za svaki novi kod (duplikati unutar 2 s su već odbačeni). */
  onCode: (code: string) => void;
  /** Pokreni kameru odmah (inače po zadnjem izboru korisnika). */
  autoStart?: boolean;
  /** Privremeno ne javljaj kodove (npr. dok je otvoren dijalog). */
  paused?: boolean;
  className?: string;
  height?: string;
  /** false = zvuk daje roditelj (npr. tek kad zna je li uređaj pronađen). */
  beepOnRead?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const dedupe = useRef(createDedupe(2000));
  const onCodeRef = useRef(onCode);
  const pausedRef = useRef(paused);
  const beepRef = useRef(beepOnRead);
  onCodeRef.current = onCode;
  pausedRef.current = paused;
  beepRef.current = beepOnRead;

  const [support, setSupport] = useState<CameraSupport | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<'native' | 'zxing' | null>(null);
  const [torch, setTorch] = useState<{ available: boolean; on: boolean }>({ available: false, on: false });
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraIdx, setCameraIdx] = useState(-1);
  const [flash, setFlash] = useState<string | null>(null);

  const accept = useCallback((raw: string) => {
    const code = raw.trim();
    if (!code || pausedRef.current) return;
    if (!dedupe.current(code, Date.now())) return;
    if (beepRef.current) beep(true);
    vibrate(40);
    setFlash(code);
    window.setTimeout(() => setFlash((f) => (f === code ? null : f)), 900);
    onCodeRef.current(code);
  }, []);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorch({ available: false, on: false });
    setPhase('idle');
  }, []);

  const start = useCallback(
    async (deviceId?: string) => {
      stop();
      setError(null);
      setPhase('starting');
      beep(true); // otvara AudioContext na dodir (iOS), inače bi prvi bip bio nijem
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        streamRef.current = stream;
        const video = videoRef.current!;
        const track = stream.getVideoTracks()[0];
        // neprekidno izoštravanje i bljeskalica ako ih kamera nudi
        const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };
        if (caps.focusMode?.includes('continuous')) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {});
        }
        setTorch({ available: !!caps.torch, on: false });

        const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput');
        setCameras(devices);
        const current = track.getSettings().deviceId;
        setCameraIdx(devices.findIndex((d) => d.deviceId === current));

        const Native = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
        let formats: string[] = [];
        if (Native) {
          const supported = (await Native.getSupportedFormats?.().catch(() => [])) ?? [];
          formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
        }

        if (Native && formats.length) {
          video.srcObject = stream;
          await video.play().catch(() => {});
          const detector = new Native({ formats });
          let alive = true;
          let timer = 0;
          const tick = async () => {
            if (!alive) return;
            if (video.readyState >= 2) {
              try {
                for (const r of await detector.detect(video)) accept(r.rawValue);
              } catch {
                /* pojedinačni okvir nije uspio — nastavlja se */
              }
            }
            timer = window.setTimeout(tick, 120);
          };
          void tick();
          stopRef.current = () => {
            alive = false;
            clearTimeout(timer);
          };
          setEngine('native');
        } else {
          const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
          const hints = new Map();
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.CODABAR, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.ITF, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX,
          ]);
          hints.set(DecodeHintType.TRY_HARDER, true);
          const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120, delayBetweenScanSuccess: 300 });
          const controls = await reader.decodeFromStream(stream, video, (result) => {
            if (result) accept(result.getText());
          });
          stopRef.current = () => controls.stop();
          setEngine('zxing');
        }
        setPhase('running');
        writePref(true);
      } catch (e) {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setPhase('error');
        setError(cameraErrorMessage((e as { name?: string })?.name));
      }
    },
    [accept, stop],
  );

  useEffect(() => {
    const s = cameraSupport({
      isSecureContext: window.isSecureContext,
      hostname: window.location.hostname,
      hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
    });
    setSupport(s);
    if (s === 'ok' && (autoStart || readPref())) void start();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // kamera se gasi kad kartica preglednika nije vidljiva (baterija, privatnost)
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && streamRef.current) stop();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [stop]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const on = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch({ available: true, on });
    } catch {
      setTorch({ available: false, on: false });
    }
  };

  const switchCamera = () => {
    if (cameras.length < 2) return;
    const next = cameras[(cameraIdx + 1) % cameras.length];
    void start(next.deviceId);
  };

  if (support === 'insecure') {
    return (
      <div className={cn('flex items-start gap-2 rounded-lg bg-warn-soft p-3 text-sm text-warn', className)}>
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <p>
          Kamera radi samo preko sigurne veze (<b>https://</b>) ili na <b>localhost</b>. Otvorite program preko HTTPS adrese — do tada upišite kod
          ručno ili koristite ručni čitač barkodova.
        </p>
      </div>
    );
  }
  if (support === 'unsupported') {
    return (
      <div className={cn('rounded-lg bg-muted p-3 text-sm text-fg-3', className)}>
        Ovaj preglednik ne podržava kameru. Upišite kod ručno ili koristite ručni čitač barkodova.
      </div>
    );
  }

  return (
    <div className={cn('relative overflow-hidden rounded-lg bg-black text-white', height, className)} data-scanner={phase}>
      <video ref={videoRef} playsInline muted autoPlay className={cn('size-full object-cover', phase !== 'running' && 'invisible')} />
      {phase === 'running' && (
        <>
          {/* okvir za ciljanje */}
          <div className="pointer-events-none absolute inset-x-[12%] top-1/2 h-[38%] -translate-y-1/2 rounded-lg border-2 border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]">
            <div className="absolute inset-x-2 top-1/2 h-px bg-red-500/80" />
          </div>
          <div className="absolute right-2 top-2 flex gap-1.5">
            {torch.available && (
              <button type="button" onClick={toggleTorch} className="grid size-10 place-items-center rounded-full bg-black/50" aria-label={torch.on ? 'Ugasi svjetlo' : 'Upali svjetlo'}>
                {torch.on ? <FlashlightOff className="size-5" /> : <Flashlight className="size-5" />}
              </button>
            )}
            {cameras.length > 1 && (
              <button type="button" onClick={switchCamera} className="grid size-10 place-items-center rounded-full bg-black/50" aria-label="Promijeni kameru">
                <RefreshCw className="size-5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                writePref(false);
                stop();
              }}
              className="grid size-10 place-items-center rounded-full bg-black/50"
              aria-label="Ugasi kameru"
            >
              <CameraOff className="size-5" />
            </button>
          </div>
          <span className="absolute bottom-2 left-2 rounded bg-black/50 px-1.5 py-0.5 text-[11px] text-white/80">
            {engine === 'native' ? 'Čitač preglednika' : 'ZXing'}
            {paused ? ' · pauza' : ''}
          </span>
          {flash && (
            <div className="absolute inset-x-3 bottom-3 truncate rounded-md bg-ok px-3 py-2 text-center font-mono text-sm font-semibold text-white shadow-lg">{flash}</div>
          )}
        </>
      )}
      {phase !== 'running' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
          {error && <p className="max-w-sm text-sm text-white/85">{error}</p>}
          <Button variant="primary" size="lg" loading={phase === 'starting'} icon={<Camera className="size-5" />} onClick={() => void start()}>
            {phase === 'error' ? 'Pokušaj ponovno' : 'Uključi kameru'}
          </Button>
          {phase === 'idle' && <p className="text-xs text-white/60">Ručni čitač barkodova radi i bez kamere.</p>}
        </div>
      )}
    </div>
  );
}
