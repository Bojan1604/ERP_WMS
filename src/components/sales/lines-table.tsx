'use client';

import { X } from 'lucide-react';
import { Badge } from '@/components/ui/misc';
import { Input } from '@/components/ui/field';
import { amount, pct } from '@/lib/format';
import { deviceLineKey, groupLines, lineNet } from '@/domain/invoice';
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
  // izmjena grupirane stavke (više uređaja istog modela) vrijedi za sve njene uređaje
  const set = (keys: string[], patch: Partial<EditorLine>) => onChange(lines.map((l) => (keys.includes(l.key) ? { ...l, ...patch } : l)));
  const remove = (keys: string[]) => onChange(lines.filter((l) => !keys.includes(l.key)));
  const inv = mode === 'invoice';
  const groups = groupLines(lines, deviceLineKey);

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
          {groups.map((g, i) => {
            const l = g.lines[0];
            const keys = g.lines.map((x) => x.key);
            const qty = g.lines.reduce((a, x) => a + x.qty, 0);
            const net = g.lines.reduce((a, x) => a + lineNet(x), 0);
            const cost = g.lines.reduce((a, x) => a + (x.cost ?? 0) * x.qty, 0);
            const margin = cost ? grossMargin(net, cost) : null;
            const serials = g.lines.filter((x) => x.serial);
            return (
              <tr key={l.key} className="align-top">
                <td className="pt-2.5 text-fg-3">
                  <span className="sm:hidden">Stavka </span>
                  {i + 1}
                </td>
                <td className="max-sm:col-span-2">
                  <Input value={l.description} onChange={(e) => set(keys, { description: e.target.value })} aria-label="Opis" />
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
                    <Badge tone={l.kind === 'DEVICE' ? 'brand' : l.kind === 'MODEL' ? 'info' : 'neutral'}>{KIND_LABEL[l.kind]}</Badge>
                    {serials.length === 1 && <span className="font-mono text-fg-2">SN {serials[0].serial}</span>}
                    {serials.length > 1 &&
                      serials.map((x) => (
                        <span key={x.key} className="inline-flex items-center gap-0.5 rounded bg-muted py-px pl-1.5 pr-0.5 font-mono text-fg-2">
                          {x.serial}
                          <button type="button" onClick={() => remove([x.key])} className="rounded p-0.5 hover:bg-bad-soft hover:text-bad-strong" aria-label={`Ukloni ${x.serial}`} title="Ukloni ovaj uređaj">
                            <X className="size-3" />
                          </button>
                        </span>
                      ))}
                    {l.agreedPrice && <Badge tone="ok">cjenik</Badge>}
                    {l.kind === 'MODEL' && l.modelId && stock && <span>na skladištu: {stock[l.modelId] ?? 0}</span>}
                    {cost > 0 && (
                      <span>
                        nabavna {amount(cost)} · marža {pct(margin)}
                      </span>
                    )}
                  </div>
                </td>
                {inv && (
                  <td>
                    <Input value={l.kpd} onChange={(e) => set(keys, { kpd: e.target.value })} placeholder="NN.NN.NN" aria-label="KPD" className="font-mono text-sm" />
                  </td>
                )}
                <td>
                  <Input value={l.unit} onChange={(e) => set(keys, { unit: e.target.value })} aria-label="Jedinica" />
                </td>
                <td>
                  <NumberInput value={qty} disabled={l.kind === 'DEVICE'} onValue={(v) => set(keys, { qty: v ?? 0 })} aria-label="Količina" />
                </td>
                <td>
                  <NumberInput value={l.unitPrice} onValue={(v) => set(keys, { unitPrice: v ?? 0, agreedPrice: false })} aria-label="Cijena" />
                </td>
                <td>
                  <NumberInput value={l.discountPct} onValue={(v) => set(keys, { discountPct: v ?? 0 })} aria-label="Popust" />
                </td>
                {inv && (
                  <td>
                    {l.kind === 'DEVICE' ? (
                      <NumberInput value={l.warrantyMonths} nullable onValue={(v) => set(keys, { warrantyMonths: v === null ? null : Math.round(v) })} aria-label="Jamstvo (mj)" />
                    ) : null}
                  </td>
                )}
                <td className="num pt-2.5 font-medium">{amount(net)}</td>
                <td className="pt-1.5 max-sm:absolute max-sm:right-2 max-sm:top-1.5">
                  <button
                    type="button"
                    onClick={() => remove(keys)}
                    className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-bad-soft hover:text-bad-strong"
                    aria-label={keys.length > 1 ? `Ukloni stavku (${keys.length} uređaja)` : 'Ukloni stavku'}
                  >
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
