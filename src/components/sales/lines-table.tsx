'use client';

import { X } from 'lucide-react';
import { Badge } from '@/components/ui/misc';
import { Input } from '@/components/ui/field';
import { amount, pct } from '@/lib/format';
import { deviceLineKey, groupLines, lineNet } from '@/domain/invoice';
import { grossMargin } from '@/domain/pricing';
import { r2 } from '@/domain/money';
import { NumberInput } from './inputs';
import { KpdInput } from './kpd-input';
import { isRentLine, switchLineType, type LineType } from './line-tools';
import type { CompanyDefaults, EditorLine, ModelOpt } from './types';

const KIND_LABEL: Record<EditorLine['kind'], string> = { DEVICE: 'Uređaj', MODEL: 'Model', SERVICE: 'Usluga', MANUAL: 'Ručno' };

/** Kontekst za stavke najma: vrsta dokumenta, mjeseci naplate i šifrarnici za zadani KPD. */
export interface RentContext {
  docType: string;
  months: number;
  company: CompanyDefaults;
  models: ModelOpt[];
  /** Stavke smiju biti i najam (miješani račun / ponuda za najam). */
  allowRent: boolean;
  /** Rata iz modula Najam: vrsta i mjesečne cijene se ne mijenjaju ovdje. */
  locked?: boolean;
}

/** Tablica stavki u editoru računa i ponude. */
export function LinesTable({
  lines,
  onChange,
  mode,
  stock,
  rent,
  showCost = true,
}: {
  lines: EditorLine[];
  onChange: (lines: EditorLine[]) => void;
  mode: 'invoice' | 'quote';
  stock?: Record<string, number>;
  rent?: RentContext;
  /** Nabavna cijena i marža (pravo „costs"). */
  showCost?: boolean;
}) {
  // izmjena grupirane stavke (više uređaja istog modela) vrijedi za sve njene uređaje
  const set = (keys: string[], patch: Partial<EditorLine>) => onChange(lines.map((l) => (keys.includes(l.key) ? { ...l, ...patch } : l)));
  const remove = (keys: string[]) => onChange(lines.filter((l) => !keys.includes(l.key)));
  const switchType = (keys: string[], to: LineType) => rent && onChange(lines.map((l) => (keys.includes(l.key) ? switchLineType(l, to, rent) : l)));
  const inv = mode === 'invoice';
  // isti model, cijena i vrsta → jedna stavka s popisom serijskih
  const groups = groupLines(lines, (l) => {
    const k = deviceLineKey(l);
    return k === null ? null : `${k}|${l.lineType ?? ''}|${l.monthly ?? ''}`;
  });

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
            {inv && <th className="w-36">KPD</th>}
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
            const serials = g.lines.filter((x) => x.serial);
            const isRent = rent ? isRentLine(l, rent.docType) : false;
            const margin = cost && !isRent ? grossMargin(net, cost) : null;
            const canSwitch = !!rent?.allowRent && !rent.locked && l.kind !== 'SERVICE';
            const months = l.months ?? 1;
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
                    {canSwitch ? (
                      <select
                        value={isRent ? 'RENT' : 'SALE'}
                        onChange={(e) => switchType(keys, e.target.value as LineType)}
                        aria-label="Vrsta stavke"
                        title="Vrsta stavke: prodaja ili najam — prenosi se na račun i određuje KPD i tekst"
                        className={`h-5 rounded border border-line bg-panel px-1 text-xs ${isRent ? 'font-medium text-brand' : ''}`}
                      >
                        <option value="SALE">prodaja</option>
                        <option value="RENT">najam</option>
                      </select>
                    ) : (
                      isRent && <Badge tone="info">najam</Badge>
                    )}
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
                    {l.existing && <Badge tone="info">postojeći najam</Badge>}
                    {l.kind === 'MODEL' && l.modelId && stock && <span>na skladištu: {stock[l.modelId] ?? 0}</span>}
                    {showCost && cost > 0 && !isRent && (
                      <span>
                        nabavna {amount(cost)} · marža {pct(margin)}
                      </span>
                    )}
                  </div>
                </td>
                {inv && (
                  <td>
                    <KpdInput value={l.kpd} onChange={(v) => set(keys, { kpd: v })} />
                  </td>
                )}
                <td>
                  <Input value={l.unit} onChange={(e) => set(keys, { unit: e.target.value })} aria-label="Jedinica" />
                </td>
                <td>
                  <NumberInput value={qty} disabled={l.kind === 'DEVICE'} onValue={(v) => set(keys, { qty: v ?? 0 })} aria-label="Količina" />
                </td>
                <td>
                  {isRent && inv ? (
                    <>
                      <NumberInput
                        value={l.monthly ?? l.unitPrice}
                        disabled={rent?.locked}
                        onValue={(v) => set(keys, { monthly: v ?? 0, unitPrice: r2((v ?? 0) * months), agreedPrice: false })}
                        aria-label="Mjesečni najam"
                        title="Mjesečni najam — iznos na računu je mjesečno × broj mjeseci naplate"
                      />
                      <span className="mt-0.5 block text-right text-xs text-fg-3">
                        €/mj × {months} = {amount(l.unitPrice)}
                      </span>
                    </>
                  ) : (
                    <>
                      <NumberInput value={l.unitPrice} onValue={(v) => set(keys, { unitPrice: v ?? 0, agreedPrice: false, ...(isRent ? { monthly: v ?? 0 } : {}) })} aria-label="Cijena" />
                      {isRent && <span className="mt-0.5 block text-right text-xs text-fg-3">€/mj</span>}
                    </>
                  )}
                </td>
                <td>
                  <NumberInput value={l.discountPct} onValue={(v) => set(keys, { discountPct: v ?? 0 })} aria-label="Popust" />
                </td>
                {inv && (
                  <td>
                    {l.kind === 'DEVICE' && !isRent ? (
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
