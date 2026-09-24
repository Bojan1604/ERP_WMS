'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAction, type ServerAction } from '@/components/ui/action';
import type { PartnerLookup } from '@/server/lookup';

type Input = { oib: string | null; vatId: string | null; country: string };

/** Postavlja vrijednost polja u obrascu (polja su nekontrolirana — FormData ih šalje takve). */
function setField(form: HTMLFormElement, name: string, value: string, overwrite = true) {
  const el = form.elements.namedItem(name);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !value) return;
  if (!overwrite && el.value.trim()) return;
  el.value = value;
}

/**
 * Gumb „Dohvati" uz OIB: naziv, adresa i poštanski broj iz Sudskog registra
 * (ili VIES-a), i provjera u AMS-u može li partner primati eRačune.
 */
export function OibLookupButton({ lookup, oib, country, onFound }: { lookup: ServerAction<Input, PartnerLookup>; oib: string; country: string; onFound: (r: PartnerLookup) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { run, pending } = useAction(lookup, { refresh: false });
  const go = async () => {
    const form = ref.current?.closest('form');
    if (!form) return;
    const vatId = (form.elements.namedItem('vatId') as HTMLInputElement | null)?.value ?? '';
    const res = await run({ oib: oib || null, vatId: vatId || null, country });
    if (!res.ok || !res.data) return;
    const i = res.data.info;
    if (i?.found) {
      setField(form, 'name', i.name);
      setField(form, 'address', i.street);
      setField(form, 'zip', i.zip);
      setField(form, 'city', i.city);
      setField(form, 'email', i.email, false);
      setField(form, 'vatId', i.vatId, false);
    }
    onFound(res.data);
  };
  return (
    <span ref={ref}>
      <Button type="button" onClick={go} loading={pending} icon={<Search className="size-4" />} title="Naziv i adresa iz Sudskog registra (VIES za strane firme) i provjera AMS-a za eRačun">
        Dohvati
      </Button>
    </span>
  );
}

/** Ishod dohvata ispod osnovnih podataka. */
export function OibLookupResult({ r }: { r: PartnerLookup }) {
  const i = r.info;
  const src = i?.source === 'sudreg' ? 'Sudskog registra' : 'VIES-a (EU registar obveznika PDV-a)';
  return (
    <div className="space-y-1.5 rounded-md bg-muted px-3 py-2 text-sm">
      {i?.found ? (
        <p className="flex items-start gap-1.5">
          {i.active ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />}
          <span>
            Dohvaćeno iz {src}
            {i.fullName && i.fullName !== i.name ? <> · puni naziv: {i.fullName}</> : null}
            {i.legalForm ? <> · {i.legalForm}</> : null}
            {i.mbs ? <> · MBS {i.mbs}</> : null}
            {i.status ? <> · {i.status}</> : null}
            {!i.active && <b className="text-warn"> — subjekt nije aktivan</b>}
          </span>
        </p>
      ) : i?.error ? (
        <p className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /> <span>{i.error} Podatke upišite ručno.</span>
        </p>
      ) : null}
      {r.ams.checked &&
        (r.ams.error ? (
          <p className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /> <span>AMS provjera nije uspjela: {r.ams.error}</span>
          </p>
        ) : r.ams.registered ? (
          <p className="flex items-start gap-1.5">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
            <span>
              U AMS adresaru — prima eRačune.{r.ams.demo && <span className="text-fg-3"> (demo posrednik)</span>}
            </span>
          </p>
        ) : (
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 size-4 shrink-0 text-fg-3" />
            <span>Nije u AMS adresaru — ne prima eRačune; račune mu fiskalizirajte bez slanja i dostavite PDF-om.</span>
          </p>
        ))}
      {r.notes.map((n) => (
        <p key={n} className="flex items-start gap-1.5 text-fg-3">
          <Info className="mt-0.5 size-4 shrink-0" /> <span>{n}</span>
        </p>
      ))}
    </div>
  );
}
