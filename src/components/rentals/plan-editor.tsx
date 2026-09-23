'use client';

import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { BILLING_MONTHS, type BillingCode } from '@/domain/billing';
import { monthsBetween } from '@/domain/dates';
import { parseNumber, r2 } from '@/domain/money';
import { eur } from '@/lib/format';
import { BILLING_OPTIONS, MONTH_OPTIONS, emptyRow, type PlanRow, type SeasonMode } from '@/domain/plan';

const SEASON_OPTIONS: { value: SeasonMode; label: string }[] = [
  { value: 'contract', label: 'Kao ugovor' },
  { value: 'year', label: 'Cijela godina' },
  { value: 'custom', label: 'Sezona' },
];

/**
 * Plan naplate uređaja: niz razdoblja, svako s vlastitom učestalošću, cijenom
 * i sezonom. Razdoblje traje do „do", do početka sljedećeg ili do kraja ugovora.
 * Prazan plan = uređaj slijedi uvjete ugovora.
 */
export function PlanEditor({
  rows,
  onChange,
  basePrice,
  defaultFrom,
}: {
  rows: PlanRow[];
  onChange: (rows: PlanRow[]) => void;
  /** Mjesečna cijena uređaja (ako je ista za sve) — za prikaz rate kad cijena razdoblja nije upisana. */
  basePrice?: number | null;
  defaultFrom?: string;
}) {
  const set = (i: number, patch: Partial<PlanRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const rate = (r: PlanRow) => {
    const price = r.price.trim() ? parseNumber(r.price) : basePrice;
    if (price === null || price === undefined) return null;
    const step = BILLING_MONTHS[r.billing] || (r.to ? monthsBetween(r.from, r.to) : 1);
    return r2(price * step);
  };

  return (
    <div className="space-y-2">
      <p className="text-sm text-fg-3">
        Cijena je uvijek <b>mjesečni najam</b>; rata = mjesečno × mjeseci naplate (kvartalno ×3, polugodišnje ×6, godišnje ×12,
        jednokratno × mjeseci razdoblja). Prazna cijena = osnovna cijena uređaja. Prazno „do" = do sljedećeg razdoblja ili kraja ugovora.
      </p>
      <div className="overflow-x-auto scroll-slim">
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Od</th>
              <th>Do</th>
              <th>Naplata</th>
              <th className="num">Mjesečno €</th>
              <th className="num">Rata</th>
              <th>Sezona</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const amount = rate(r);
              return (
                <tr key={i}>
                  <td>
                    <Input type="date" aria-label="Od" className="w-36" value={r.from} onChange={(e) => set(i, { from: e.target.value })} required />
                  </td>
                  <td>
                    <Input type="date" aria-label="Do" className="w-36" value={r.to} onChange={(e) => set(i, { to: e.target.value })} />
                  </td>
                  <td>
                    <Select aria-label="Naplata" className="w-36" options={BILLING_OPTIONS} value={r.billing} onChange={(e) => set(i, { billing: e.target.value as BillingCode })} />
                  </td>
                  <td>
                    <Input
                      aria-label="Mjesečna cijena"
                      inputMode="decimal"
                      className="w-24 text-right"
                      placeholder="osnovna"
                      value={r.price}
                      onChange={(e) => set(i, { price: e.target.value })}
                    />
                  </td>
                  <td className="num text-fg-3">{amount === null ? '—' : eur(amount)}</td>
                  <td>
                    <div className="flex items-center gap-1">
                      <Select
                        aria-label="Sezona"
                        className="w-32"
                        options={SEASON_OPTIONS}
                        value={r.season}
                        onChange={(e) => set(i, { season: e.target.value as SeasonMode })}
                      />
                      {r.season === 'custom' && (
                        <>
                          <Select aria-label="Sezona od" className="w-28" options={MONTH_OPTIONS} value={String(r.seasonFrom)} onChange={(e) => set(i, { seasonFrom: Number(e.target.value) })} />
                          <Select aria-label="Sezona do" className="w-28" options={MONTH_OPTIONS} value={String(r.seasonTo)} onChange={(e) => set(i, { seasonTo: Number(e.target.value) })} />
                        </>
                      )}
                    </div>
                  </td>
                  <td className="num">
                    <button type="button" aria-label="Ukloni razdoblje" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-muted hover:text-bad-strong">
                      <X className="size-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={7} className="py-3 text-sm text-fg-3">
                  Nema vlastitih razdoblja — uređaj slijedi uvjete ugovora.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, emptyRow(rows.at(-1), defaultFrom)])}>
          Dodaj razdoblje
        </Button>
        <span className="text-xs text-fg-3">npr. u rujnu jednokratno, a od 1. listopada kvartalno</span>
      </div>
    </div>
  );
}
