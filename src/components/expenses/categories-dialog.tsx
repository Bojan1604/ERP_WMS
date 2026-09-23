'use client';

import { useState } from 'react';
import { Tags } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';

const SYSTEM = ['Nabava robe', 'Otpis opreme'];

/** Kategorije troškova: dodavanje i preimenovanje. */
export function CategoriesDialog({ categories, action }: { categories: Array<{ id: string; name: string }>; action: ServerAction<{ id: string | null; name: string }> }) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [fresh, setFresh] = useState('');
  const { run, pending, error } = useAction(action);
  return (
    <>
      <Button icon={<Tags className="size-4" />} onClick={() => setOpen(true)}>
        Kategorije
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Kategorije troškova" size="sm" footer={<Button onClick={() => setOpen(false)}>Zatvori</Button>}>
        <ul className="space-y-1.5">
          {categories.map((c) => {
            const val = names[c.id] ?? c.name;
            const locked = SYSTEM.includes(c.name);
            return (
              <li key={c.id} className="flex gap-2">
                <Input value={val} disabled={locked} title={locked ? 'Sistemska kategorija — na nju se knjiže primke i otpisi' : undefined} onChange={(e) => setNames({ ...names, [c.id]: e.target.value })} />
                {!locked && val.trim() !== c.name && (
                  <Button size="sm" variant="primary" loading={pending} onClick={() => run({ id: c.id, name: val })} className="h-8">
                    Spremi
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex gap-2 border-t border-line pt-3">
          <Input value={fresh} placeholder="Nova kategorija…" onChange={(e) => setFresh(e.target.value)} />
          <Button
            variant="primary"
            disabled={!fresh.trim()}
            loading={pending}
            onClick={async () => {
              const r = await run({ id: null, name: fresh });
              if (r.ok) setFresh('');
            }}
          >
            Dodaj
          </Button>
        </div>
        <div className="mt-2">
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}
