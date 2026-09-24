'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { SelectionBar } from '@/components/ui/selection';
import { useAction, type ServerAction } from '@/components/ui/action';
import { useToast } from '@/components/ui/toast';

/** Skupno označavanje plaćenosti označenih redaka (ulazni računi). */
export function PaidBar({ action, today }: { action: ServerAction<{ ids: string[]; paidDate: string | null }, unknown>; today: string }) {
  const [ask, setAsk] = useState<{ ids: string[]; clear: () => void } | null>(null);
  const [d, setD] = useState(today);
  const toast = useToast();
  // upozorenje: plaćanje je upisano, ali posrednik nije primio status „plaćen" (eRačuni)
  const { run, pending } = useAction(action, {
    onSuccess: (data) => {
      const w = (data as { warning?: string | null } | undefined)?.warning;
      if (w) toast('bad', w);
    },
  });
  return (
    <>
      {/* na mobitelu traka označenih stoji pri dnu ekrana, iznad donjeg izbornika */}
      <div className="max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[calc(5.25rem+env(safe-area-inset-bottom))] max-sm:z-30 max-sm:[&>div]:mb-0">
        <SelectionBar>
          {(ids, clear) => (
            <>
              <Button size="sm" variant="primary" onClick={() => setAsk({ ids, clear })}>
                Označi plaćeno
              </Button>
              <Button
                size="sm"
                loading={pending}
                onClick={async () => {
                  const r = await run({ ids, paidDate: null });
                  if (r.ok) clear();
                }}
              >
                Označi neplaćeno
              </Button>
            </>
          )}
        </SelectionBar>
      </div>
      <Dialog
        open={!!ask}
        onClose={() => setAsk(null)}
        title={`Plaćeno — ${ask?.ids.length ?? 0} računa`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setAsk(null)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={async () => {
                const r = await run({ ids: ask?.ids ?? [], paidDate: d });
                if (r.ok) {
                  ask?.clear();
                  setAsk(null);
                }
              }}
            >
              Označi plaćeno
            </Button>
          </>
        }
      >
        <Field label="Datum plaćanja">
          <Input type="date" value={d} onChange={(e) => setD(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
