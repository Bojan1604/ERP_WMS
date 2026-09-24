'use client';

import { useState } from 'react';
import { CheckCheck, FileArchive, Printer, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SelectionBar } from '@/components/ui/selection';
import { useToast } from '@/components/ui/toast';
import { useAction, type ServerAction } from '@/components/ui/action';

/** Najviše dokumenata u jednom ispisu (ključevi idu u URL). */
const PRINT_MAX = 300;

/**
 * Radnje nad označenim dokumentima: ZIP za knjigovođu (nakon preuzimanja pita
 * treba li ih označiti kao poslane), ispis i ručno (od)označavanje.
 */
export function AccountantBar({ action, canMark }: { action: ServerAction<{ keys: string[]; sent: boolean }>; canMark: boolean }) {
  const toast = useToast();
  const { run, pending } = useAction(action);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ keys: string[]; clear: () => void } | null>(null);

  const download = async (keys: string[], clear: () => void) => {
    setBusy(true);
    try {
      const res = await fetch('/api/knjigovodja/zip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }) });
      if (!res.ok) {
        toast('bad', (await res.text()) || 'Arhivu nije moguće izraditi.');
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'knjigovodja.zip';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const [docs, xml, att] = (res.headers.get('x-zip-summary') ?? '').split(';');
      toast('ok', `Preuzeto: ${docs ?? keys.length} dokumenata · eRačun XML ${xml ?? 0} · priloga ${att ?? 0}`);
      if (canMark) setAsk({ keys, clear });
    } catch {
      toast('bad', 'Preuzimanje nije uspjelo — provjerite vezu i pokušajte ponovno.');
    } finally {
      setBusy(false);
    }
  };

  const print = (keys: string[]) => {
    if (keys.length > PRINT_MAX) return toast('bad', `Za ispis označite najviše ${PRINT_MAX} dokumenata.`);
    window.open(`/knjigovodja/ispis?ids=${encodeURIComponent(keys.join(','))}`, '_blank', 'noopener');
  };

  const mark = async (keys: string[], sent: boolean, clear: () => void) => {
    const r = await run({ keys, sent });
    if (r.ok) clear();
  };

  return (
    <>
      <div className="max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[calc(5.25rem+env(safe-area-inset-bottom))] max-sm:z-30 max-sm:[&>div]:mb-0">
        <SelectionBar>
          {(keys, clear) => (
            <>
              <Button size="sm" variant="primary" loading={busy} icon={<FileArchive className="size-3.5" />} onClick={() => download(keys, clear)}>
                Preuzmi ZIP
              </Button>
              <Button size="sm" icon={<Printer className="size-3.5" />} onClick={() => print(keys)}>
                Ispis
              </Button>
              {canMark && (
                <>
                  <Button size="sm" loading={pending} icon={<CheckCheck className="size-3.5" />} onClick={() => mark(keys, true, clear)}>
                    Označi poslano
                  </Button>
                  <Button size="sm" loading={pending} icon={<Undo2 className="size-3.5" />} onClick={() => mark(keys, false, clear)}>
                    Nije poslano
                  </Button>
                </>
              )}
            </>
          )}
        </SelectionBar>
      </div>
      <Dialog
        open={!!ask}
        onClose={() => setAsk(null)}
        title="Poslano knjigovođi?"
        size="sm"
        footer={
          <>
            <Button onClick={() => setAsk(null)}>Ne</Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={async () => {
                if (!ask) return;
                const r = await run({ keys: ask.keys, sent: true });
                if (r.ok) {
                  ask.clear();
                  setAsk(null);
                }
              }}
            >
              Označi kao poslano
            </Button>
          </>
        }
      >
        <p className="text-base text-fg-2">
          Označiti {ask?.keys.length ?? 0} preuzetih dokumenata kao poslano knjigovođi? Datum slanja upisuje se na svaki dokument; u popisu ostaju vidljivi s oznakom
          „poslano".
        </p>
      </Dialog>
    </>
  );
}
