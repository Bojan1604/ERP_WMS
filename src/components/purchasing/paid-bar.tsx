'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { SelectionBar } from '@/components/ui/selection';
import { useAction, type ServerAction } from '@/components/ui/action';

/** Skupno označavanje plaćenosti označenih redaka (ulazni računi). */
export function PaidBar({ action, today }: { action: ServerAction<{ ids: string[]; paidDate: string | null }>; today: string }) {
  const [ask, setAsk] = useState<{ ids: string[]; clear: () => void } | null>(null);
  const [d, setD] = useState(today);
  const { run, pending } = useAction(action);
  return (
    <>
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
