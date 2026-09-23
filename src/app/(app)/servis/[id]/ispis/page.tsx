import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { pageAccess } from '@/server/auth';
import { getCompany, modelLabel } from '@/server/queries/lookups';
import { getServiceOrder } from '@/server/queries/service';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { warrantyEnd } from '@/domain/pricing';
import { DocTable, DocumentShell, docDate } from '@/components/doc/document';
import { PrintButton } from '@/components/ui/print-button';
import { SERVICE_STATUS } from '@/components/service/labels';
import { amount } from '@/lib/format';

type Params = Record<string, string | string[] | undefined>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <section className="mt-4">
      <p className="text-[10px] uppercase tracking-wider text-black/50">{title}</p>
      <p className="whitespace-pre-line">{children}</p>
    </section>
  );
}

/** Servisni nalog (zaprimanje) ili nalog za dostavu (povrat klijentu) za ispis. */
export default async function ServicePrintPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const user = await pageAccess('service', 'view');
  const { id } = await params;
  const delivery = (await searchParams).vrsta === 'dostava';
  const [o, company] = await Promise.all([getServiceOrder(user.companyId, id), getCompany(user.companyId)]);
  if (!o) notFound();
  const item = o.item;
  const wEnd = item ? warrantyEnd(toISO(item.warrantyStart ?? item.issueDate), item.warrantyMonths) : null;

  const rows = [
    [item ? modelLabel(item.model) : '—', o.serial ?? '—', o.underWarranty ? `da${wEnd ? ` (do ${docDate(wEnd)})` : ''}` : 'ne', delivery && o.replacement ? 'zamijenjen' : ''],
  ];
  if (delivery && o.replacement) rows.push([modelLabel(o.replacement.model), o.replacement.serial, 'nastavlja jamstvo izvornog', 'zamjenski uređaj']);

  return (
    <>
      <div className="no-print mb-4 flex items-center justify-between">
        <Link prefetch={false} href={`/servis/${id}`} className="text-sm text-fg-3 hover:text-fg">
          ← Nalog {o.number}
        </Link>
        <div className="flex gap-2">
          <Link prefetch={false} href={delivery ? `/servis/${id}/ispis` : `/servis/${id}/ispis?vrsta=dostava`} className="self-center text-sm text-fg-3 hover:text-fg">
            {delivery ? 'Servisni nalog' : 'Nalog za dostavu'}
          </Link>
          <PrintButton />
        </div>
      </div>
      <DocumentShell
        company={company}
        title={delivery ? 'Nalog za dostavu' : 'Servisni nalog'}
        number={o.number}
        meta={[
          ['Prijavljeno', docDate(o.reportedAt)],
          ...(o.receivedAt ? ([['Zaprimljeno', docDate(o.receivedAt)]] as Array<[string, string]>) : []),
          ...(delivery && o.closedAt ? ([['Zatvoreno', docDate(o.closedAt)]] as Array<[string, string]>) : []),
          ['Status', SERVICE_STATUS[o.status].label],
          ...(o.invoice?.number ? ([['Račun', o.invoice.number]] as Array<[string, string]>) : []),
        ]}
        party={o.partner}
        partyLabel="Klijent"
        signatures={delivery ? ['Uređaj predao', 'Uređaj preuzeo (klijent)'] : ['Uređaj predao (klijent)', 'Uređaj zaprimio']}
      >
        <DocTable head={['Uređaj', 'Serijski broj', 'Jamstvo', '']} rows={rows} />
        <Section title="Opis kvara">{o.issue}</Section>
        {delivery && (
          <>
            <Section title="Dijagnoza">{o.diagnosis}</Section>
            <Section title="Poduzeto">{o.action}</Section>
            <Section title="Rješenje">{o.solution}</Section>
          </>
        )}
        <Section title="Poruka klijentu">{o.publicNote}</Section>
        {!o.underWarranty && num(o.cost) > 0 && (
          <p className="mt-4 font-semibold">Trošak popravka (izvan jamstva): {amount(num(o.cost))} EUR + PDV</p>
        )}
        {!delivery && (
          <p className="mt-6 text-[10.5px] text-black/60">
            Potpisom klijent potvrđuje predaju uređaja u stanju opisanom na ovom nalogu. Popravci izvan jamstva naplaćuju se nakon prihvaćene ponude.
          </p>
        )}
      </DocumentShell>
    </>
  );
}
