'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Badge } from '@/components/ui/misc';
import { Field, Input, Select } from '@/components/ui/field';
import { useAction } from '@/components/ui/action';
import { BILLING_LABEL, type BillingCode } from '@/domain/billing';
import { formatDate, periodLabel } from '@/domain/dates';
import { partnerContracts } from '@/app/(app)/prodaja/racuni/actions';
import { monthsOfBilling } from '@/domain/sales-lines';
import { plural } from '@/domain/plural';

export interface RentTermsValue {
  startDate: string;
  billing: BillingCode;
  months: number | null;
  seasonFrom: number | null;
  seasonTo: number | null;
}

/** „Zatim naplata prelazi u": druga učestalost naplate od zadanog datuma. */
export interface RentNextValue {
  billing: BillingCode;
  from: string;
}

export interface ContractOpt {
  id: string;
  number: string;
  billing: BillingCode;
  startDate: string;
  seasonFrom: number | null;
  seasonTo: number | null;
  status: string;
  devices: number;
}

const MONTHS = ['siječanj', 'veljača', 'ožujak', 'travanj', 'svibanj', 'lipanj', 'srpanj', 'kolovoz', 'rujan', 'listopad', 'studeni', 'prosinac'];
const BILLINGS: BillingCode[] = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'];

/** Mjeseci naplate za stavke najma: prema ugovoru ili uvjetima novog ugovora. */
export function rentMonthsFor(contractId: string | null, contracts: ContractOpt[], terms: RentTermsValue): number {
  if (contractId && contractId !== 'new') {
    const c = contracts.find((x) => x.id === contractId);
    return c ? monthsOfBilling(c.billing) : 1;
  }
  return monthsOfBilling(terms.billing);
}

/**
 * Uvjeti najma na računu (Prodaja): odabir postojećeg ugovora kupca ili
 * „+ Novi ugovor" (naplata, početak, trajanje, sezona) i razdoblje koje račun
 * pokriva. Uređaji s računa vežu se uz ugovor pri izdavanju.
 */
export function RentCard({
  partnerId,
  contractId,
  period,
  terms,
  next,
  locked,
  lockedLabel,
  onContract,
  onPeriod,
  onTerms,
  onNext,
  onContracts,
}: {
  partnerId: string | null;
  contractId: string | null;
  period: string;
  terms: RentTermsValue;
  next: RentNextValue | null;
  /** Rata iz modula Najam — ugovor i razdoblje su zadani. */
  locked: boolean;
  lockedLabel?: { id: string; number: string } | null;
  onContract: (id: string | null, c: ContractOpt | null) => void;
  onPeriod: (p: string) => void;
  onTerms: (t: RentTermsValue) => void;
  onNext: (n: RentNextValue | null) => void;
  onContracts: (list: ContractOpt[]) => void;
}) {
  const [list, setList] = useState<ContractOpt[]>([]);
  const load = useAction(partnerContracts, { refresh: false });
  useEffect(() => {
    if (!partnerId || locked) return;
    let live = true;
    load.run({ partnerId }).then((r) => {
      if (!live || !r.ok) return;
      const rows = (r.data ?? []) as ContractOpt[];
      setList(rows);
      onContracts(rows);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId, locked]);

  if (locked) {
    return (
      <Card title="Najam" className="mb-4">
        <p className="text-base text-fg-2">
          Rata ugovora{' '}
          {lockedLabel ? (
            <Link prefetch={false} href={`/najam/ugovori/${lockedLabel.id}`} className="link">
              {lockedLabel.number}
            </Link>
          ) : (
            '—'
          )}{' '}
          za <b>{period ? periodLabel(period) : '—'}</b>
          {period ? ' ' : '. '}Ugovor, razdoblje i mjesečne cijene određuje modul Najam.
        </p>
      </Card>
    );
  }

  const seasonal = !!(terms.seasonFrom && terms.seasonTo);
  const isNew = contractId === 'new';
  const setT = (p: Partial<RentTermsValue>) => onTerms({ ...terms, ...p });
  const chosen = list.find((c) => c.id === contractId) ?? null;
  return (
    <Card
      title="Uvjeti najma"
      className="mb-4"
      actions={<span className="text-xs text-fg-3 max-sm:hidden">Uređaji s najmom vežu se na odabrani ugovor pri izdavanju računa.</span>}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
        <Field label="Ugovor o najmu" required className="md:col-span-3">
          <Select
            value={contractId ?? ''}
            disabled={!partnerId}
            onChange={(e) => {
              const v = e.target.value || null;
              onContract(v, list.find((c) => c.id === v) ?? null);
            }}
            options={[
              { value: '', label: partnerId ? '— odaberite ugovor —' : 'Prvo odaberite kupca' },
              ...list.map((c) => ({ value: c.id, label: `${c.number} · ${BILLING_LABEL[c.billing]} · ${c.devices} ${plural(c.devices, 'uređaj', 'uređaja', 'uređaja')}${c.status === 'PAUSED' ? ' · pauziran' : ''}` })),
              { value: 'new', label: '+ Novi ugovor za ovog kupca' },
            ]}
          />
        </Field>
        <Field label="Razdoblje najma" hint="Prazno = prva nefakturirana rata uređaja s računa (ili mjesec računa); isto razdoblje se ne fakturira dvaput" className="md:col-span-3">
          <Input type="month" value={period} onChange={(e) => onPeriod(e.target.value)} title="Mjesec na koji se račun odnosi — određuje koja se rata smatra izdanom" />
        </Field>
        {isNew && (
          <>
            <Field label="Naplata" className="md:col-span-2">
              <Select value={terms.billing} onChange={(e) => setT({ billing: e.target.value as BillingCode })} options={BILLINGS.map((b) => ({ value: b, label: BILLING_LABEL[b] }))} />
            </Field>
            <Field label="Početak naplate" className="md:col-span-2">
              <Input type="date" value={terms.startDate} onChange={(e) => setT({ startDate: e.target.value })} />
            </Field>
            <Field label="Trajanje (mj.)" hint="Prazno = neodređeno" className="md:col-span-2">
              <Input
                inputMode="numeric"
                value={terms.months ?? ''}
                onChange={(e) => setT({ months: e.target.value.trim() === '' ? null : Math.max(0, Math.round(Number(e.target.value) || 0)) || null })}
              />
            </Field>
            <Field label="Sezonska naplata" className="md:col-span-2">
              <Select
                value={seasonal ? 'da' : 'bez'}
                onChange={(e) => setT(e.target.value === 'da' ? { seasonFrom: 4, seasonTo: 10 } : { seasonFrom: null, seasonTo: null })}
                options={[
                  { value: 'bez', label: 'Cijela godina' },
                  { value: 'da', label: 'Samo dio godine' },
                ]}
              />
            </Field>
            {seasonal && (
              <>
                <Field label="Od mjeseca" className="md:col-span-2">
                  <Select value={String(terms.seasonFrom)} onChange={(e) => setT({ seasonFrom: Number(e.target.value) })} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
                </Field>
                <Field label="Do mjeseca" className="md:col-span-2">
                  <Select value={String(terms.seasonTo)} onChange={(e) => setT({ seasonTo: Number(e.target.value) })} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
                </Field>
              </>
            )}
          </>
        )}
        {contractId && (
          <>
            <Field label="Zatim naplata prelazi u" hint="Za uređaje koji se ovim računom dodaju na ugovor" className="md:col-span-3">
              <Select
                value={next?.billing ?? ''}
                onChange={(e) => onNext(e.target.value ? { billing: e.target.value as BillingCode, from: next?.from ?? '' } : null)}
                options={[{ value: '', label: '— bez promjene —' }, ...BILLINGS.map((b) => ({ value: b, label: BILLING_LABEL[b] }))]}
              />
            </Field>
            {next && (
              <Field label="Od datuma" required className="md:col-span-3">
                <Input type="date" value={next.from} onChange={(e) => onNext({ ...next, from: e.target.value })} />
              </Field>
            )}
          </>
        )}
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-fg-3">
        {chosen && (
          <>
            <Badge tone="info">{BILLING_LABEL[chosen.billing]}</Badge>
            <span>Novi uređaji na ugovoru naplaćuju se od datuma računa; uređaji koji su već na ugovoru zadržavaju svoje uvjete.</span>
          </>
        )}
        {isNew && <span>Otvara se novi ugovor s ovim uvjetima; uređaji s računa preuzimaju mjesečnu cijenu sa stavke.</span>}
        <span>
          Cijena najma unosi se kao <b>mjesečna</b>; iznos na računu je mjesečno × {rentMonthsFor(contractId, list, terms)} mj.
          {next?.from && ` Od ${formatDate(next.from)} uređaji prelaze na ${BILLING_LABEL[next.billing].toLowerCase()} naplatu.`}
        </span>
      </p>
    </Card>
  );
}
