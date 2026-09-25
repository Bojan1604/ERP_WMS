'use client';

import { useState } from 'react';
import { ArrowRightLeft, Check, FileSignature } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/misc';
import { Field, Input, Select } from '@/components/ui/field';
import { FormError, useAction } from '@/components/ui/action';
import { BILLING_LABEL } from '@/domain/billing';
import { today } from '@/domain/dates';
import { convertQuoteAction, convertQuoteToContractAction } from '@/app/(app)/prodaja/ponude/actions';
import { DevicePicker } from './device-picker';
import type { DeviceOpt, ModelOpt, NamedOpt } from './types';
import { plural } from '@/domain/plural';

export interface ConvertLine {
  id: string;
  kind: 'DEVICE' | 'MODEL' | 'SERVICE' | 'MANUAL';
  description: string;
  qty: number;
  modelId: string | null;
  itemId: string | null;
  serial: string | null;
  itemAvailable: boolean;
  /** Stavka najma (mjesečna cijena). */
  rent?: boolean;
}

const MONTHS = ['siječanj', 'veljača', 'ožujak', 'travanj', 'svibanj', 'lipanj', 'srpanj', 'kolovoz', 'rujan', 'listopad', 'studeni', 'prosinac'];

/**
 * „Pretvori u račun" (i za stavke najma „Pretvori u ugovor"): za svaku stavku
 * po modelu bira se točno onoliko uređaja sa skladišta kolika je količina;
 * zatim poslužitelj izrađuje nacrt računa ili otvara ugovor o najmu.
 */
export function QuoteConvert({
  quoteId,
  partnerId,
  lines,
  models,
  categories,
  warehouses,
  canContract = false,
  hasContract = false,
  label = 'Pretvori u račun',
  showCost = true,
}: {
  quoteId: string;
  partnerId: string;
  lines: ConvertLine[];
  models: ModelOpt[];
  categories: NamedOpt[];
  warehouses: NamedOpt[];
  /** Pravo otvaranja ugovora (najam, uređivanje) i ponuda ima uređaje za najam. */
  canContract?: boolean;
  /** Ponuda je već pretvorena u ugovor (stavke najma su na ugovoru). */
  hasContract?: boolean;
  label?: string;
  showCost?: boolean;
}) {
  const [open, setOpen] = useState<'invoice' | 'contract' | null>(null);
  const [picks, setPicks] = useState<Record<string, DeviceOpt[]>>({});
  const [pickFor, setPickFor] = useState<ConvertLine | null>(null);
  const [terms, setTerms] = useState({ startDate: today(), billing: 'MONTHLY' as 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL', months: '24', seasonal: false, seasonFrom: 4, seasonTo: 10 });
  const toInvoice = useAction(convertQuoteAction);
  const toContract = useAction(convertQuoteToContractAction);

  // za ugovor: samo stavke najma s uređajem ili modelom
  const shown = open === 'contract' ? lines.filter((l) => l.rent && (l.kind === 'DEVICE' || l.kind === 'MODEL')) : lines;
  const modelLines = shown.filter((l) => l.kind === 'MODEL');
  const unavailable = shown.filter((l) => l.kind === 'DEVICE' && !l.itemAvailable);
  const ready = !unavailable.length && modelLines.every((l) => (picks[l.id]?.length ?? 0) === l.qty);
  const taken = [
    ...lines.map((l) => l.itemId).filter((x): x is string => !!x),
    ...Object.entries(picks)
      .filter(([k]) => k !== pickFor?.id)
      .flatMap(([, ds]) => ds.map((d) => d.id)),
  ];
  const pickIds = () => Object.fromEntries(Object.entries(picks).map(([k, ds]) => [k, ds.map((d) => d.id)]));
  const rentLines = lines.filter((l) => l.rent && (l.kind === 'DEVICE' || l.kind === 'MODEL'));
  const pending = toInvoice.pending || toContract.pending;

  return (
    <>
      {canContract && !hasContract && rentLines.length > 0 && (
        <Button icon={<FileSignature className="size-4" />} onClick={() => setOpen('contract')}>
          Pretvori u ugovor
        </Button>
      )}
      <Button variant="primary" icon={<ArrowRightLeft className="size-4" />} onClick={() => setOpen('invoice')}>
        {label}
      </Button>
      <Dialog
        open={!!open}
        onClose={() => setOpen(null)}
        title={open === 'contract' ? 'Ugovor o najmu iz ponude' : 'Pretvaranje u račun'}
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(null)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!ready}
              onClick={() =>
                open === 'contract'
                  ? toContract.run({
                      id: quoteId,
                      picks: pickIds(),
                      startDate: terms.startDate,
                      billing: terms.billing,
                      months: terms.months.trim() ? Number(terms.months) : null,
                      seasonFrom: terms.seasonal ? terms.seasonFrom : null,
                      seasonTo: terms.seasonal ? terms.seasonTo : null,
                    })
                  : toInvoice.run({ id: quoteId, picks: pickIds() })
              }
            >
              {open === 'contract' ? 'Otvori ugovor' : 'Izradi nacrt računa'}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-base text-fg-2">
          {open === 'contract'
            ? 'Otvara se ugovor o najmu za kupca; uređaji sa stavki najma idu na ugovor s mjesečnom cijenom iz ponude i dobivaju status „U najmu". Stavke prodaje ostaju za račun.'
            : 'Nastaje nacrt računa sa stavkama i cijenama iz ponude; ponuda se označava prihvaćenom i veže uz račun.'}
          {open === 'invoice' && rentLines.length > 0 && (hasContract ? ' Stavke najma vežu se uz ugovor iz ponude.' : ' Za stavke najma na računu odaberite ugovor ili „+ Novi ugovor".')}
          {modelLines.length > 0 && ' Za stavke po modelu odaberite konkretne uređaje sa skladišta.'}
        </p>
        {open === 'contract' && (
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="Početak najma">
              <Input type="date" value={terms.startDate} onChange={(e) => setTerms({ ...terms, startDate: e.target.value })} />
            </Field>
            <Field label="Naplata">
              <Select
                value={terms.billing}
                onChange={(e) => setTerms({ ...terms, billing: e.target.value as typeof terms.billing })}
                options={(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const).map((b) => ({ value: b, label: BILLING_LABEL[b] }))}
              />
            </Field>
            <Field label="Trajanje (mj.)" hint="Prazno = neodređeno">
              <Input inputMode="numeric" value={terms.months} onChange={(e) => setTerms({ ...terms, months: e.target.value.replace(/\D/g, '') })} />
            </Field>
            <Field label="Sezona">
              <Select
                value={terms.seasonal ? 'da' : 'bez'}
                onChange={(e) => setTerms({ ...terms, seasonal: e.target.value === 'da' })}
                options={[
                  { value: 'bez', label: 'Cijela godina' },
                  { value: 'da', label: 'Samo dio godine' },
                ]}
              />
            </Field>
            {terms.seasonal && (
              <>
                <Field label="Od mjeseca">
                  <Select value={String(terms.seasonFrom)} onChange={(e) => setTerms({ ...terms, seasonFrom: Number(e.target.value) })} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
                </Field>
                <Field label="Do mjeseca">
                  <Select value={String(terms.seasonTo)} onChange={(e) => setTerms({ ...terms, seasonTo: Number(e.target.value) })} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
                </Field>
              </>
            )}
          </div>
        )}
        {unavailable.length > 0 && (
          <p className="mb-3 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">
            Uređaji više nisu na skladištu: {unavailable.map((l) => l.serial).join(', ')} — uklonite ih iz ponude prije pretvaranja.
          </p>
        )}
        <ul className="divide-y divide-line rounded-md border border-line">
          {shown.map((l) => {
            const chosen = picks[l.id] ?? [];
            return (
              <li key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    {l.description}
                    {l.rent && (
                      <Badge tone="info" className="ml-1.5">
                        najam
                      </Badge>
                    )}
                  </p>
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
        <FormError error={toInvoice.error ?? toContract.error} />
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
          rent={pickFor.rent}
          showCost={showCost}
          title={`${pickFor.description} — odaberite ${pickFor.qty} ${plural(pickFor.qty, 'uređaj', 'uređaja', 'uređaja')}`}
        />
      )}
    </>
  );
}
