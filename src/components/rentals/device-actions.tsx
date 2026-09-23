'use client';

import { useState } from 'react';
import { CalendarRange, Euro, Pause, Play, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { SelectionBar } from '@/components/ui/selection';
import { useAction } from '@/components/ui/action';
import { parseNumber } from '@/domain/money';
import type { PlanPeriodInput } from '@/domain/billing';
import { PlanEditor } from './plan-editor';
import { planFromRows, rowsFromPlan, validatePlan, type PlanRow } from '@/domain/plan';
import { itemsPatchAction, removeItemsAction } from '@/app/(app)/najam/ugovori/actions';

export interface DeviceInfo {
  id: string;
  serial: string;
  monthly: number;
  plan: PlanPeriodInput[];
  paused: boolean;
  rented: boolean;
}

type Mode = null | 'price' | 'plan' | 'remove';

/** Traka grupnih radnji nad označenim uređajima ugovora. */
export function DeviceBulkBar({ contractId, devices, defaultFrom }: { contractId: string; devices: DeviceInfo[]; defaultFrom: string }) {
  const [mode, setMode] = useState<Mode>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [clearSel, setClearSel] = useState<() => void>(() => () => {});
  const [price, setPrice] = useState('');
  const [plan, setPlan] = useState<PlanRow[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const byId = new Map(devices.map((d) => [d.id, d]));
  const picked = ids.map((id) => byId.get(id)).filter((d): d is DeviceInfo => Boolean(d));

  const done = () => {
    setMode(null);
    clearSel();
  };
  const patch = useAction(itemsPatchAction, { onSuccess: done });
  const remove = useAction(removeItemsAction, { onSuccess: done });

  const open = (m: Mode, sel: string[], clear: () => void) => {
    setIds(sel);
    setClearSel(() => clear);
    setPlanError(null);
    const list = sel.map((id) => byId.get(id)!).filter(Boolean);
    if (m === 'price') {
      const same = list.every((d) => d.monthly === list[0]?.monthly);
      setPrice(same && list[0] ? String(list[0].monthly).replace('.', ',') : '');
    }
    if (m === 'plan') {
      const first = JSON.stringify(list[0]?.plan ?? []);
      setPlan(list.every((d) => JSON.stringify(d.plan) === first) ? rowsFromPlan(list[0]?.plan) : []);
    }
    setMode(m);
  };

  const uniformPrice = picked.length && picked.every((d) => d.monthly === picked[0].monthly) ? picked[0].monthly : null;

  return (
    <>
      <SelectionBar>
        {(sel, clear) => {
          const list = sel.map((id) => byId.get(id)).filter((d): d is DeviceInfo => Boolean(d));
          return (
            <>
              <Button size="sm" icon={<Euro className="size-3.5" />} onClick={() => open('price', sel, clear)}>
                Mjesečna cijena
              </Button>
              <Button size="sm" icon={<CalendarRange className="size-3.5" />} onClick={() => open('plan', sel, clear)}>
                Plan naplate
              </Button>
              {list.some((d) => !d.paused) && (
                <Button
                  size="sm"
                  icon={<Pause className="size-3.5" />}
                  loading={patch.pending}
                  onClick={() => {
                    setClearSel(() => clear);
                    patch.run({ contractId, ids: sel, status: 'PAUSED' });
                  }}
                >
                  Pauziraj
                </Button>
              )}
              {list.some((d) => d.paused) && (
                <Button
                  size="sm"
                  icon={<Play className="size-3.5" />}
                  loading={patch.pending}
                  onClick={() => {
                    setClearSel(() => clear);
                    patch.run({ contractId, ids: sel, status: 'ACTIVE' });
                  }}
                >
                  Nastavi
                </Button>
              )}
              {list.some((d) => d.rented) && (
                <Button size="sm" variant="danger" icon={<Undo2 className="size-3.5" />} onClick={() => open('remove', sel, clear)}>
                  Ukloni s ugovora
                </Button>
              )}
            </>
          );
        }}
      </SelectionBar>

      <Dialog
        open={mode === 'price'}
        onClose={() => setMode(null)}
        title={`Mjesečna cijena — ${picked.length} uređaja`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setMode(null)}>Odustani</Button>
            <Button variant="primary" loading={patch.pending} onClick={() => patch.run({ contractId, ids, monthly: parseNumber(price) })} disabled={!price.trim()}>
              Primijeni
            </Button>
          </>
        }
      >
        <Field label="Mjesečni najam (€)" hint="Cijena se uvijek unosi mjesečno; rata se računa iz plana naplate.">
          <Input autoFocus inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="text-right" />
        </Field>
      </Dialog>

      <Dialog
        open={mode === 'plan'}
        onClose={() => setMode(null)}
        title={`Plan naplate — ${picked.length} uređaja`}
        size="xl"
        footer={
          <>
            <Button onClick={() => setMode(null)}>Odustani</Button>
            <Button loading={patch.pending} onClick={() => patch.run({ contractId, ids, plan: [] })}>
              Vrati na uvjete ugovora
            </Button>
            <Button
              variant="primary"
              loading={patch.pending}
              onClick={() => {
                const p = planFromRows(plan);
                const err = validatePlan(p);
                setPlanError(err);
                if (!err) patch.run({ contractId, ids, plan: p });
              }}
            >
              Spremi plan
            </Button>
          </>
        }
      >
        <PlanEditor rows={plan} onChange={setPlan} basePrice={uniformPrice} defaultFrom={defaultFrom} />
        {planError && <p className="mt-2 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">{planError}</p>}
      </Dialog>

      <Dialog
        open={mode === 'remove'}
        onClose={() => setMode(null)}
        title="Ukloni s ugovora"
        size="sm"
        footer={
          <>
            <Button onClick={() => setMode(null)}>Odustani</Button>
            <Button variant="danger" loading={remove.pending} onClick={() => remove.run({ contractId, ids: picked.filter((d) => d.rented).map((d) => d.id) })}>
              Najavi povrat
            </Button>
          </>
        }
      >
        <p className="text-base text-fg-2">
          Uređaji su još kod klijenta: prelaze u <b>U dolasku</b> i ostaju na ugovoru dok ih skladište ne zaprimi (Skladište → Izlaz i
          povrat). Izdani računi se ne mijenjaju.
        </p>
        <p className="mt-2 text-sm text-fg-3">{picked.filter((d) => d.rented).map((d) => d.serial).join(', ')}</p>
      </Dialog>
    </>
  );
}
