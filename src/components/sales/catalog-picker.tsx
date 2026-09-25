'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { controlClass } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { eur } from '@/lib/format';

export interface CatalogEntry {
  id: string;
  label: string;
  hint?: string | null;
  price?: number | null;
}

/** Odabir iz šifrarnika (usluge, modeli) — klik dodaje stavku, prozor ostaje otvoren. */
export function CatalogPicker({
  open,
  onClose,
  title,
  entries,
  onPick,
  empty = 'Šifrarnik je prazan.',
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  entries: CatalogEntry[];
  onPick: (id: string) => void;
  empty?: string;
  /** Dodatne radnje u podnožju (npr. „+ Nova usluga"). */
  footer?: React.ReactNode;
}) {
  const [q, setQ] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? entries.filter((e) => `${e.label} ${e.hint ?? ''}`.toLowerCase().includes(t)) : entries;
  }, [q, entries]);
  const close = () => {
    setQ('');
    setAdded([]);
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title={title} size="md" footer={footer}>
      <div className="relative mb-3">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Traži…" className={cn(controlClass, 'h-8 pl-8')} />
      </div>
      <ul className="divide-y divide-line rounded-md border border-line">
        {list.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => {
                onPick(e.id);
                setAdded((a) => [...a, e.id]);
              }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{e.label}</span>
                {e.hint && <span className="block text-xs text-fg-3">{e.hint}</span>}
              </span>
              {e.price != null && <span className="tnum text-sm text-fg-2">{eur(e.price)}</span>}
              {added.includes(e.id) && <span className="text-xs font-medium text-ok">dodano ×{added.filter((x) => x === e.id).length}</span>}
            </button>
          </li>
        ))}
        {!list.length && <li className="px-3 py-6 text-center text-sm text-fg-3">{entries.length ? 'Nema rezultata.' : empty}</li>}
      </ul>
    </Dialog>
  );
}
