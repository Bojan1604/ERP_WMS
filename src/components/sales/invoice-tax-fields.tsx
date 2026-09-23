'use client';

import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { CHARGE_KINDS } from '@/domain/invoice';
import { NumberInput } from './inputs';
import type { ChargeKind, EditorCharge } from './types';

export const TAX_CATEGORIES = [
  { value: 'S', label: 'S — standardna stopa' },
  { value: 'K', label: 'K — isporuka unutar EU' },
  { value: 'G', label: 'G — izvoz izvan EU' },
  { value: 'AE', label: 'AE — prijenos porezne obveze' },
  { value: 'E', label: 'E — oslobođeno PDV-a' },
  { value: 'Z', label: 'Z — nulta stopa' },
  { value: 'O', label: 'O — izvan sustava PDV-a' },
];

/** Popust na cijeli dokument, PDV i neoporezive naknade. */
export function TaxFields({
  v,
  set,
  showCharges = true,
}: {
  v: {
    vatRate: number;
    taxCategory?: string;
    taxExemptReason?: string;
    discountPct: number;
    discountAmount: number;
    advanceAmount?: number;
    charges?: EditorCharge[];
  };
  set: (patch: Partial<{ vatRate: number; taxCategory: string; taxExemptReason: string; discountPct: number; discountAmount: number; advanceAmount: number; charges: EditorCharge[] }>) => void;
  showCharges?: boolean;
}) {
  const charges = v.charges ?? [];
  const setCharge = (i: number, patch: Partial<EditorCharge>) => set({ charges: charges.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Popust na dokument %">
          <NumberInput value={v.discountPct} onValue={(x) => set({ discountPct: x ?? 0 })} />
        </Field>
        <Field label="Popust iznos €">
          <NumberInput value={v.discountAmount} onValue={(x) => set({ discountAmount: x ?? 0 })} />
        </Field>
        <Field label="Stopa PDV-a %">
          <NumberInput value={v.vatRate} onValue={(x) => set({ vatRate: x ?? 0 })} />
        </Field>
        {v.advanceAmount !== undefined && (
          <Field label="Uračunati predujam €">
            <NumberInput value={v.advanceAmount} onValue={(x) => set({ advanceAmount: x ?? 0 })} />
          </Field>
        )}
      </div>
      {v.taxCategory !== undefined && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[14rem_1fr]">
          <Field label="Porezna kategorija">
            <Select value={v.taxCategory} options={TAX_CATEGORIES} onChange={(e) => set({ taxCategory: e.target.value })} />
          </Field>
          {v.taxCategory !== 'S' && (
            <Field label="Razlog oslobođenja (ispisuje se na računu)">
              <Input value={v.taxExemptReason ?? ''} onChange={(e) => set({ taxExemptReason: e.target.value })} />
            </Field>
          )}
        </div>
      )}
      {showCharges && (
        <div>
          <p className="mb-1 text-sm font-medium text-fg-2">Neoporezive naknade</p>
          {charges.map((c, i) => {
            const isPct = !!CHARGE_KINDS[c.kind].pct;
            return (
              <div key={i} className="mb-2 grid grid-cols-[11rem_1fr_7rem_2rem] items-center gap-2">
                <select value={c.kind} onChange={(e) => setCharge(i, { kind: e.target.value as ChargeKind })} className="h-8 rounded-md border border-line-strong bg-panel px-2 text-base">
                  {Object.entries(CHARGE_KINDS).map(([k, d]) => (
                    <option key={k} value={k}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <Input value={c.label} placeholder="Naziv (npr. Turistička pristojba)" onChange={(e) => setCharge(i, { label: e.target.value })} />
                {isPct ? (
                  <NumberInput value={c.pct} nullable placeholder="%" onValue={(x) => setCharge(i, { pct: x })} />
                ) : (
                  <NumberInput value={c.amount} nullable placeholder="€" onValue={(x) => setCharge(i, { amount: x })} />
                )}
                <button type="button" onClick={() => set({ charges: charges.filter((_, j) => j !== i) })} className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-bad-soft hover:text-bad-strong" aria-label="Ukloni naknadu">
                  <X className="size-4" />
                </button>
              </div>
            );
          })}
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set({ charges: [...charges, { kind: 'N', label: '', amount: null, pct: null }] })}>
            Naknada
          </Button>
        </div>
      )}
    </div>
  );
}
