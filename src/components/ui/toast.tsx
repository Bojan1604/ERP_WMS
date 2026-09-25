'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Toast {
  id: number;
  tone: 'ok' | 'bad';
  text: string;
}

const Ctx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((v) => [...v, { id, tone, text }]);
    setTimeout(() => setItems((v) => v.filter((t) => t.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);
  // obavijesti su u „top layeru" (popover) — iznad otvorenog <dialog> i njegove pozadine; ponovno
  // prikazivanje pri svakoj novoj obavijesti ih stavlja na vrh (dijalog otvoren nakon njih ostaje ispod)
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof el.showPopover !== 'function') return;
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      if (items.length) el.showPopover();
    } catch {
      // stariji preglednik — obavijesti ostaju obične (fixed) kao prije
    }
  }, [items]);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div
        ref={box}
        popover="manual"
        className="no-print pointer-events-none fixed inset-auto bottom-4 right-4 z-[100] m-0 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 overflow-visible border-0 bg-transparent p-0"
      >
        {items.map((t) => (
          <div key={t.id} role="status" className={cn('pointer-events-auto flex items-start gap-2 rounded-lg bg-panel px-3.5 py-2.5 text-base shadow-[var(--shadow-pop)]')}>
            {t.tone === 'ok' ? <CheckCircle2 className="mt-px size-4 shrink-0 text-ok" /> : <XCircle className="mt-px size-4 shrink-0 text-bad-strong" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
