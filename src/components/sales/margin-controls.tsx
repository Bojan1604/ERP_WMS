'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Input } from '@/components/ui/field';
import { FormError, useAction } from '@/components/ui/action';
import { parseNumber } from '@/domain/money';
import { setGlobalMarginAction, setModelMarginAction } from '@/app/(app)/prodaja/marze/actions';

/** Globalna bruto marža s „Primijeni na sve" (briše marže po modelima i uređajima). */
export function GlobalMarginForm({ value }: { value: number }) {
  const [v, setV] = useState(String(value).replace('.', ','));
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState(true);
  const [items, setItems] = useState(true);
  const { run, pending, error } = useAction(setGlobalMarginAction);
  const pctNum = parseNumber(v);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-fg-3">Globalna bruto marža</span>
      <Input value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" className="w-20 text-right" aria-label="Globalna bruto marža %" />
      <span className="text-sm text-fg-3">%</span>
      <Button size="sm" loading={pending} onClick={() => run({ pct: pctNum, resetModels: false, resetItems: false })}>
        Spremi
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} title="Postavlja maržu i vraća pojedinačne marže modela i uređaja na globalnu">
        Primijeni na sve
      </Button>
      <FormError error={error} />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Globalna marža za sve"
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={async () => {
                const r = await run({ pct: pctNum, resetModels: models, resetItems: items });
                if (r.ok) setOpen(false);
              }}
            >
              Primijeni
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-base text-fg-2">
          <p>
            Zadana bruto marža postaje <b className="text-fg">{String(pctNum).replace('.', ',')} %</b>. Preporučena cijena = nabavna ÷ (1 − marža).
          </p>
          <Checkbox label="Vrati marže po modelima na globalnu" checked={models} onChange={(e) => setModels(e.target.checked)} />
          <Checkbox label="Vrati marže upisane na uređajima na globalnu" checked={items} onChange={(e) => setItems(e.target.checked)} />
          <FormError error={error} />
        </div>
      </Dialog>
    </div>
  );
}

/** Marža modela u tablici „Preporučene marže" (prazno = globalna); sprema se pri izlasku iz polja. */
export function ModelMarginInput({ modelId, value, global, disabled }: { modelId: string; value: number | null; global: number; disabled?: boolean }) {
  const [v, setV] = useState(value === null ? '' : String(value).replace('.', ','));
  const { run, pending } = useAction(setModelMarginAction);
  const save = () => {
    const next = v.trim() === '' ? null : parseNumber(v);
    if (next === value) return;
    void run({ modelId, pct: next });
  };
  return (
    <Input
      value={v}
      disabled={disabled || pending}
      placeholder={String(global).replace('.', ',')}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      inputMode="decimal"
      className="ml-auto h-7 w-20 text-right"
      aria-label="Bruto marža modela %"
    />
  );
}
