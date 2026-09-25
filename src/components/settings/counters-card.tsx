'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAction, type ServerAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Card } from '@/components/ui/misc';

export interface CounterRow {
  series: string;
  label: string;
  /** Zadnji dodijeljeni redni broj (0 = nijedan). */
  last: number;
  /** Najveći već izdani broj (računi) — sljedeći ne smije biti manji. */
  floor: number;
  /** Primjer sljedećeg broja u obliku dokumenta. */
  example: string;
}

function Row({ row, year, save, canEdit }: { row: CounterRow; year: number; save: ServerAction<{ series: string; year: number; next: number }>; canEdit: boolean }) {
  const min = Math.max(row.last, row.floor) + 1;
  const [next, setNext] = useState(String(min));
  const { run, pending, error } = useAction(save);
  const n = Number(next);
  const invalid = !Number.isInteger(n) || n < min;
  return (
    <tr>
      <td className="font-medium">{row.label}</td>
      <td className="font-mono text-sm text-fg-2">{row.example}</td>
      <td className="num">{row.last || '—'}</td>
      <td>
        <div className="flex items-center gap-2">
          <Input type="number" min={min} value={next} onChange={(e) => setNext(e.target.value)} disabled={!canEdit} className="w-28 text-right" aria-label={`Sljedeći broj — ${row.label}`} />
          {canEdit && (
            <Button size="sm" loading={pending} disabled={invalid || n === min} onClick={() => run({ series: row.series, year, next: n })}>
              Postavi
            </Button>
          )}
        </div>
        {(invalid || error) && <p className="mt-1 text-xs text-bad-strong">{error ?? `Najmanje ${min} (manji broj je već izdan).`}</p>}
      </td>
    </tr>
  );
}

/** Nastavak numeracije iz starog programa: sljedeći broj po vrsti dokumenta za godinu. */
export function CountersCard({ rows, year, years, save, canEdit }: { rows: CounterRow[]; year: number; years: number[]; save: ServerAction<{ series: string; year: number; next: number }>; canEdit: boolean }) {
  return (
    <Card
      title="Početni brojevi dokumenata"
      padded={false}
      actions={
        <div className="inline-flex rounded-md bg-muted p-0.5">
          {years.map((y) => (
            <Link
              prefetch={false}
              scroll={false}
              key={y}
              href={`/postavke?brojevi=${y}`}
              className={y === year ? 'h-7 rounded bg-panel px-2.5 text-sm font-medium leading-7 text-fg shadow-sm' : 'h-7 rounded px-2.5 text-sm leading-7 text-fg-3 hover:text-fg'}
            >
              {y}.
            </Link>
          ))}
        </div>
      }
    >
      <p id="brojevi" className="border-b border-line px-4 py-2.5 text-sm text-fg-3">
        Za nastavak numeracije iz starog programa upišite broj koji treba dobiti <b>sljedeći</b> dokument. Broj se može samo povećati — nikad ispod već izdanih; ostale godine kreću od 1.
      </p>
      <div className="overflow-x-auto scroll-slim">
        <table className="data-table">
          <thead>
            <tr>
              <th>Dokument</th>
              <th>Sljedeći broj</th>
              <th className="num">Zadnji dodijeljen</th>
              <th>Novi sljedeći broj</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={`${r.series}-${year}`} row={r} year={year} save={save} canEdit={canEdit} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
