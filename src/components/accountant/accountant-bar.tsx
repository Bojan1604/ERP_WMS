'use client';

import { useEffect, useState } from 'react';
import { CheckCheck, FileArchive, Printer, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SelectionBar, useSelection } from '@/components/ui/selection';
import { useToast } from '@/components/ui/toast';
import { useAction, type ServerAction } from '@/components/ui/action';
import { SendEmailButton } from '@/components/ui/send-email-button';
import { countLabel } from '@/domain/plural';

/** Najviše dokumenata u jednom ispisu (ključevi idu u URL). */
const PRINT_MAX = 300;

/**
 * Radnje nad označenim dokumentima: ZIP za knjigovođu (nakon preuzimanja pita
 * treba li ih označiti kao poslane), ispis i ručno (od)označavanje.
 */
export function AccountantBar({
  action,
  canMark,
  email,
  keysAction,
  filterQs,
  total,
}: {
  action: ServerAction<{ keys: string[]; sent: boolean }>;
  canMark: boolean;
  /** Slanje ZIP-a knjigovođi e-poštom (SendEmailButton „accountant-zip"; id = označeni ključevi odvojeni zarezom). */
  email?: { to: string | null; subject: string };
  /** „Označi sve po filtru": poslužitelj vraća ključeve svih dokumenata popisa za filtre iz URL-a. */
  keysAction: ServerAction<{ qs: string }, string[]>;
  /** Filtri popisa (bez stranice) — za „označi sve" i ispis svih. */
  filterQs: string;
  /** Broj dokumenata u popisu (sve stranice). */
  total: number;
}) {
  const toast = useToast();
  const { run, pending } = useAction(action);
  const keysRun = useAction(keysAction, { refresh: false });
  const sel = useSelection();
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ keys: string[]; clear: () => void } | null>(null);
  // svi dokumenti po filtru (ne samo ova stranica) — vrijedi dok je označena cijela stranica
  const [allKeys, setAllKeys] = useState<string[] | null>(null);
  useEffect(() => setAllKeys(null), [filterQs]);
  const pageAll = sel.ids.length > 0 && sel.selected.size === sel.ids.length;
  const allOn = !!allKeys && pageAll;
  const pick = (keys: string[]) => (allOn && allKeys ? allKeys : keys);
  const clearAll = (clear: () => void) => () => {
    setAllKeys(null);
    clear();
  };
  const selectAll = async () => {
    const r = await keysRun.run({ qs: filterQs });
    if (r.ok && r.data) setAllKeys(r.data);
  };

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
      toast('ok', `Preuzeto: ${countLabel(docs ? Number(docs) : keys.length, 'dokument', 'dokumenta', 'dokumenata')} · eRačun XML ${xml ?? 0} · priloga ${att ?? 0}`);
      if (canMark) setAsk({ keys, clear });
    } catch {
      toast('bad', 'Preuzimanje nije uspjelo — provjerite vezu i pokušajte ponovno.');
    } finally {
      setBusy(false);
    }
  };

  const print = (keys: string[]) => {
    // svi po filtru: ispis ih razrješava sam (do ACCOUNTANT_ROW_CAP po smjeru), ključevi ne idu u URL
    if (allOn) return window.open(`/knjigovodja/ispis?sve=1${filterQs ? `&${filterQs}` : ''}`, '_blank', 'noopener');
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
          {(pageKeys, pageClear) => {
            const keys = pick(pageKeys);
            const clear = clearAll(pageClear);
            return (
            <>
              {pageAll && total > sel.ids.length &&
                (allOn ? (
                  <span className="text-sm">
                    · svih <b className="text-white">{keys.length}</b> po filtru
                  </span>
                ) : (
                  <Button size="sm" loading={keysRun.pending} onClick={selectAll}>
                    Označi svih {total} po filtru
                  </Button>
                ))}
              <Button size="sm" variant="primary" loading={busy} icon={<FileArchive className="size-3.5" />} onClick={() => download(keys, clear)}>
                Preuzmi ZIP
              </Button>
              <Button size="sm" icon={<Printer className="size-3.5" />} onClick={() => print(keys)}>
                Ispis
              </Button>
              {canMark && email && (
                <SendEmailButton
                  kind="accountant-zip"
                  id={keys.join(',')}
                  defaultTo={email.to}
                  defaultSubject={email.subject}
                  defaultBody={`U privitku su dokumenti za knjigovodstvo (${keys.length}).`}
                  label="Pošalji"
                  size="sm"
                />
              )}
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
            );
          }}
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
          Označiti {countLabel(ask?.keys.length ?? 0, 'preuzeti dokument', 'preuzeta dokumenta', 'preuzetih dokumenata')} kao poslano knjigovođi? Datum slanja upisuje se na svaki dokument; u popisu ostaju vidljivi s oznakom
          „poslano".
        </p>
      </Dialog>
    </>
  );
}
