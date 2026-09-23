'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
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
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="no-print pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
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
