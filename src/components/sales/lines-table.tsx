'use client';

import { X } from 'lucide-react';
import { Badge } from '@/components/ui/misc';
import { Input } from '@/components/ui/field';
import { amount, pct } from '@/lib/format';
import { lineNet } from '@/domain/invoice';
import { grossMargin } from '@/domain/pricing';
import { NumberInput } from './inputs';
import type { EditorLine } from './types';

const KIND_LABEL: Record<EditorLine['kind'], string> = { DEVICE: 'Uređaj', MODEL: 'Model', SERVICE: 'Usluga', MANUAL: 'Ručno' };

/** Tablica stavki u editoru računa i ponude. */
export function LinesTable({
  lines,
  onChange,
  mode,
  stock,
}: {
  lines: EditorLine[];
  onChange: (lines: EditorLine[]) => void;
  mode: 'invoice' | 'quote';
  stock?: Record<string, number>;
}) {
  const set = (key: string, patch: Partial<EditorLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => onChange(lines.filter((l) => l.key !== key));
  const inv = mode === 'invoice';

  if (!lines.length) {
    return <p className="px-4 py-10 text-center text-sm text-fg-3">Još nema stavki — dodajte uređaje, usluge ili ručnu stavku.</p>;
  }

  return (
    <div className="overflow-x-auto scroll-slim">
      <table className="data-table compact">
        <thead>
          <tr>
            <th className="w-8">#</th>
            <th className="min-w-72">Opis</th>
            {inv && <th className="w-28">KPD</th>}
            <th className="w-20">Jed.</th>
            <th className="w-20 num">Kol.</th>
            <th className="w-28 num">Cijena</th>
            <th className="w-20 num">Pop. %</th>
            {inv && <th className="w-20 num">Jamstvo</th>}
            <th className="w-28 num">Iznos</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const net = lineNet(l);
            const margin = l.cost ? grossMargin(net, l.cost * l.qty) : null;
            return (
              <tr key={l.key} className="align-top">
                <td className="pt-2.5 text-fg-3">{i + 1}</td>
                <td>
                  <Input value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} aria-label="Opis" />
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
                    <Badge tone={l.kind === 'DEVICE' ? 'brand' : l.kind === 'MODEL' ? 'info' : 'neutral'}>{KIND_LABEL[l.kind]}</Badge>
                    {l.serial && <span className="font-mono text-fg-2">SN {l.serial}</span>}
                    {l.agreedPrice && <Badge tone="ok">cjenik</Badge>}
                    {l.kind === 'MODEL' && l.modelId && stock && <span>na skladištu: {stock[l.modelId] ?? 0}</span>}
                    {l.cost != null && l.cost > 0 && (
                      <span>
                        nabavna {amount(l.cost)} · marža {pct(margin)}
                      </span>
                    )}
                  </div>
                </td>
                {inv && (
                  <td>
                    <Input value={l.kpd} onChange={(e) => set(l.key, { kpd: e.target.value })} placeholder="NN.NN.NN" aria-label="KPD" className="font-mono text-sm" />
                  </td>
                )}
                <td>
                  <Input value={l.unit} onChange={(e) => set(l.key, { unit: e.target.value })} aria-label="Jedinica" />
                </td>
                <td>
                  <NumberInput value={l.qty} disabled={l.kind === 'DEVICE'} onValue={(v) => set(l.key, { qty: v ?? 0 })} aria-label="Količina" />
                </td>
                <td>
                  <NumberInput value={l.unitPrice} onValue={(v) => set(l.key, { unitPrice: v ?? 0, agreedPrice: false })} aria-label="Cijena" />
                </td>
                <td>
                  <NumberInput value={l.discountPct} onValue={(v) => set(l.key, { discountPct: v ?? 0 })} aria-label="Popust" />
                </td>
                {inv && (
                  <td>
                    {l.kind === 'DEVICE' ? (
                      <NumberInput value={l.warrantyMonths} nullable onValue={(v) => set(l.key, { warrantyMonths: v === null ? null : Math.round(v) })} aria-label="Jamstvo (mj)" />
                    ) : null}
                  </td>
                )}
                <td className="num pt-2.5 font-medium">{amount(net)}</td>
                <td className="pt-1.5">
                  <button type="button" onClick={() => remove(l.key)} className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-bad-soft hover:text-bad-strong" aria-label="Ukloni stavku">
                    <X className="size-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
