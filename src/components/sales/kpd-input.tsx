'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { controlClass } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { kpdValid } from '@/domain/sales-lines';

/**
 * KPD 2025 — unos šifre s provjerom oblika (NN.NN.NN) i tražilica šifrarnika.
 * Šifrarnik (~3 400 potkategorija, ~250 kB) učitava se dinamički tek kad se
 * tražilica prvi put otvori; sam unos šifre radi i bez njega.
 */
type Row = readonly [string, string];
let cache: ReadonlyArray<Row> | null = null;
async function loadKpd() {
  if (!cache) cache = (await import('./kpd-data')).default;
  return cache;
}
/** Naziv šifre (ako je šifrarnik već učitan). */
const kpdName = (code: string) => (cache && code ? (cache.find((r) => r[0] === code)?.[1] ?? '') : '');

/** Prijedlozi za ovu djelatnost (IT oprema, najam, usluge) — prije nego korisnik išta upiše. */
const SUGGESTED = ['26.20.12', '26.20.16', '26.20.17', '26.20.11', '26.20.40', '28.23.21', '77.33.01', '77.33.02', '62.90.10', '62.20.30', '95.10.01', '85.59.02', '46.50.10', '47.40.01'];

export function KpdInput({
  value,
  onChange,
  disabled,
  className,
  placeholder = 'NN.NN.NN',
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const bad = !!value && !kpdValid(value);
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.trim())}
        aria-label="KPD"
        aria-invalid={bad || undefined}
        title={bad ? 'KPD 2025 šifra mora biti oblika NN.NN.NN' : kpdName(value) || 'KPD 2025 šifra oblika NN.NN.NN'}
        className={cn(controlClass, 'h-8 min-w-0 flex-1 font-mono text-sm', bad && 'border-bad text-bad-strong')}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="grid size-8 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-muted hover:text-fg disabled:opacity-40"
        aria-label="Traži KPD šifru"
        title="Pretraži KPD 2025 šifrarnik"
      >
        <Search className="size-3.5" />
      </button>
      {open && (
        <KpdSearch
          onClose={() => setOpen(false)}
          onPick={(code) => {
            onChange(code);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

export function KpdSearch({ onClose, onPick }: { onClose: () => void; onPick: (code: string) => void }) {
  const [rows, setRows] = useState<ReadonlyArray<Row> | { error: string } | null>(cache);
  const [q, setQ] = useState('');
  useEffect(() => {
    let alive = true;
    loadKpd()
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setRows({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, []);

  const hits = useMemo(() => {
    if (!rows || !Array.isArray(rows)) return [] as Row[];
    const list = rows as ReadonlyArray<Row>;
    const t = q.trim().toLowerCase();
    if (!t) return SUGGESTED.map((c) => list.find((r) => r[0] === c)).filter((r): r is Row => !!r);
    const words = t.split(/\s+/);
    return list.filter((r) => r[0].startsWith(t) || words.every((w) => r[1].toLowerCase().includes(w) || r[0].includes(w))).slice(0, 80);
  }, [rows, q]);

  return (
    <Dialog open onClose={onClose} title="KPD 2025 — Klasifikacija proizvoda po djelatnostima" size="md">
      <div className="relative mb-2">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Dio naziva ili početak šifre (npr. terminal, 26.20)"
          className={cn(controlClass, 'h-8 pl-8')}
        />
      </div>
      <p className="mb-2 text-xs text-fg-3">
        {!rows
          ? 'Učitavam šifrarnik…'
          : 'error' in rows
            ? `Šifrarnik nije dostupan: ${rows.error}`
            : q.trim()
              ? `${hits.length} pogodaka`
              : 'Prijedlozi za IT opremu, najam i usluge'}
      </p>
      <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-md border border-line scroll-slim">
        {hits.map((r) => (
          <li key={r[0]}>
            <button type="button" onClick={() => onPick(r[0])} className="flex w-full items-baseline gap-3 px-3 py-1.5 text-left hover:bg-muted">
              <span className="w-20 shrink-0 font-mono text-sm font-medium">{r[0]}</span>
              <span className="text-sm">{r[1]}</span>
            </button>
          </li>
        ))}
        {rows && !('error' in rows) && q.trim() && !hits.length && <li className="px-3 py-6 text-center text-sm text-fg-3">Nema pogodaka.</li>}
      </ul>
      <p className="mt-2 text-xs text-fg-3">Izvor: DZS (KLASUS). Šifra ide na svaku stavku eRačuna.</p>
    </Dialog>
  );
}
