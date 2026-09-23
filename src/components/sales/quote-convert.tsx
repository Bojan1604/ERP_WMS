'use client';

import { useState } from 'react';
import { ArrowRightLeft, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/misc';
import { useAction } from '@/components/ui/action';
import { convertQuoteAction } from '@/app/(app)/prodaja/ponude/actions';
import { DevicePicker } from './device-picker';
import type { DeviceOpt, ModelOpt, NamedOpt } from './types';

export interface ConvertLine {
  id: string;
  kind: 'DEVICE' | 'MODEL' | 'SERVICE' | 'MANUAL';
  description: string;
  qty: number;
  modelId: string | null;
  itemId: string | null;
  serial: string | null;
  itemAvailable: boolean;
}

/**
 * „Pretvori u račun": za svaku stavku po modelu bira se točno onoliko uređaja
 * sa skladišta kolika je količina; zatim poslužitelj izrađuje nacrt računa.
 */
export function QuoteConvert({
  quoteId,
  partnerId,
  lines,
  models,
  categories,
  warehouses,
}: {
  quoteId: string;
  partnerId: string;
  lines: ConvertLine[];
  models: ModelOpt[];
  categories: NamedOpt[];
  warehouses: NamedOpt[];
}) {
  const [open, setOpen] = useState(false);
  const [picks, setPicks] = useState<Record<string, DeviceOpt[]>>({});
  const [pickFor, setPickFor] = useState<ConvertLine | null>(null);
  const { run, pending } = useAction(convertQuoteAction);

  const modelLines = lines.filter((l) => l.kind === 'MODEL');
  const unavailable = lines.filter((l) => l.kind === 'DEVICE' && !l.itemAvailable);
  const ready = !unavailable.length && modelLines.every((l) => (picks[l.id]?.length ?? 0) === l.qty);
  const taken = [
    ...lines.map((l) => l.itemId).filter((x): x is string => !!x),
    ...Object.entries(picks)
      .filter(([k]) => k !== pickFor?.id)
      .flatMap(([, ds]) => ds.map((d) => d.id)),
  ];

  return (
    <>
      <Button variant="primary" icon={<ArrowRightLeft className="size-4" />} onClick={() => setOpen(true)}>
        Pretvori u račun
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Pretvaranje ponude u račun"
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!ready}
              onClick={() => run({ id: quoteId, picks: Object.fromEntries(Object.entries(picks).map(([k, ds]) => [k, ds.map((d) => d.id)])) })}
            >
              Izradi nacrt računa
            </Button>
          </>
        }
      >
        <p className="mb-3 text-base text-fg-2">
          Nastaje nacrt računa sa stavkama i cijenama iz ponude; ponuda se označava prihvaćenom i veže uz račun.
          {modelLines.length > 0 && ' Za stavke po modelu odaberite konkretne uređaje sa skladišta.'}
        </p>
        {unavailable.length > 0 && (
          <p className="mb-3 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">
            Uređaji više nisu na skladištu: {unavailable.map((l) => l.serial).join(', ')} — uklonite ih iz ponude prije pretvaranja.
          </p>
        )}
        <ul className="divide-y divide-line rounded-md border border-line">
          {lines.map((l) => {
            const chosen = picks[l.id] ?? [];
            return (
              <li key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate">{l.description}</p>
                  {l.kind === 'MODEL' && chosen.length > 0 && <p className="font-mono text-xs text-fg-3">{chosen.map((d) => d.serial).join(', ')}</p>}
                  {l.kind === 'DEVICE' && <p className="font-mono text-xs text-fg-3">SN {l.serial}</p>}
                </div>
                <span className="text-sm text-fg-3">× {l.qty}</span>
                {l.kind === 'MODEL' ? (
                  <>
                    {chosen.length === l.qty ? (
                      <Badge tone="ok">
                        <Check className="size-3" /> odabrano
                      </Badge>
                    ) : (
                      <Badge tone="warn">
                        {chosen.length} / {l.qty}
                      </Badge>
                    )}
                    <Button size="sm" onClick={() => setPickFor(l)}>
                      Odaberi uređaje
                    </Button>
                  </>
                ) : (
                  <Badge tone={l.kind === 'DEVICE' ? (l.itemAvailable ? 'brand' : 'bad') : 'neutral'}>
                    {l.kind === 'DEVICE' ? 'uređaj' : l.kind === 'SERVICE' ? 'usluga' : 'ručno'}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      </Dialog>
      {pickFor && (
        <DevicePicker
          open={!!pickFor}
          onClose={() => setPickFor(null)}
          onPick={(ds) => setPicks((p) => ({ ...p, [pickFor.id]: ds }))}
          partnerId={partnerId}
          models={models}
          categories={categories}
          warehouses={warehouses}
          exclude={taken}
          fixedModelId={pickFor.modelId ?? undefined}
          count={pickFor.qty}
          title={`${pickFor.description} — odaberite ${pickFor.qty} uređaja`}
        />
      )}
    </>
  );
}
