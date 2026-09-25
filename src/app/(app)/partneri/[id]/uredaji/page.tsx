import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { clientSheet, readSheetParams, SHEET_MAX } from '@/server/queries/client-sheet';
import { DocumentShell, DocTable } from '@/components/doc/document';
import { PrintButton } from '@/components/ui/print-button';
import { ExportButtons } from '@/components/ui/export-buttons';
import { SegmentFilter } from '@/components/ui/filters';
import { PageHeader } from '@/components/ui/misc';
import { Pagination, readPage } from '@/components/ui/pagination';
import { BILLING_LABEL, CONTRACT_STATUS_LABEL } from '@/domain/billing';
import { formatDate, today } from '@/domain/dates';
import { seasonLabel } from '@/domain/plan';
import { amount, integer } from '@/lib/format';
import { queryWithout } from '@/lib/list-params';
import { can } from '@/domain/permissions';

export const metadata = { title: 'Popis uređaja' };

type Params = Record<string, string | string[] | undefined>;

/**
 * Popis uređaja kod klijenta („ClientSheet", C3) — za ispis, PDF, Excel i slanje
 * klijentu. Po partneru (pogledi U najmu / Prodano / Sve) ili po ugovoru (?ugovor=).
 */
export default async function PartnerDevicesDoc({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { view, contractId } = readSheetParams(sp);
  // popis ugovora otvara se s ugovora (pravo najma), popis partnera s partnera
  const user = await pageAccess(contractId ? 'rentals' : 'partners');
  const { id } = await params;
  // dokument po stranicama od SHEET_MAX uređaja (zbrojevi preko svih; izvoz sadrži sve)
  const pg = readPage(sp, SHEET_MAX);
  const [sheet, company] = await Promise.all([clientSheet(user.companyId, id, { view, contractId, skip: pg.skip, rentals: can(user.perms, 'rentals', 'view') }), getCompany(user.companyId)]);
  if (!sheet) notFound();
  const { partner, contract, rows, counts } = sheet;
  const now = today();
  const shownView = contract ? 'najam' : view;
  // bez prava na najam nema ugovora, mjesečnog najma ni uvjeta ugovora
  const rent = shownView !== 'prodano' && sheet.rentals;
  const qs = queryWithout(sp).toString();
  const pages = Math.ceil(sheet.total / SHEET_MAX);
  const back = contract ? { href: `/najam/ugovori/${contract.id}`, label: `Ugovor ${contract.number}` } : { href: `/partneri/${id}?tab=uredaji`, label: partner.name };

  return (
    <>
      <div className="no-print">
        <PageHeader
          back={
            <Link prefetch={false} href={back.href} className="hover:underline">
              ← {back.label}
            </Link>
          }
          title={contract ? `Uređaji po ugovoru ${contract.number}` : 'Popis uređaja za klijenta'}
          subtitle={partner.name}
          actions={
            <>
              <ExportButtons href={`/api/partneri/${id}/uredaji${qs ? `?${qs}` : ''}`} />
              <PrintButton />
            </>
          }
        />
        {!contract && (
          <div className="mb-3">
            <SegmentFilter
              name="pogled"
              options={[
                { value: '', label: `U najmu (${integer(counts.najam)})` },
                { value: 'prodano', label: `Prodano (${integer(counts.prodano)})` },
                { value: 'sve', label: `Sve (${integer(counts.sve)})` },
              ]}
            />
          </div>
        )}
        {pages > 1 && <Pagination page={pg.page} pageSize={SHEET_MAX} total={sheet.total} params={sp} basePath={`/partneri/${id}/uredaji`} />}
      </div>
      <DocumentShell
        company={company}
        title="Popis uređaja"
        number={contract ? contract.number : null}
        meta={[
          ['Datum', formatDate(now)],
          [shownView === 'prodano' ? 'Prodanih uređaja' : shownView === 'sve' ? 'Uređaja' : 'Uređaja u najmu', integer(sheet.total)],
          ...(pages > 1 ? ([['Stranica', `${pg.page} / ${pages}`]] as Array<[string, string]>) : []),
          ...(rent && sheet.monthly > 0 ? ([['Mjesečno', `${amount(sheet.monthly)} EUR`]] as Array<[string, string]>) : []),
        ]}
        party={partner}
        partyLabel="Klijent"
        signatures={['Za ' + company.name, 'Klijent']}
        footer={<p>Popis je informativan i prikazuje stanje na dan {formatDate(now)} Molimo da odstupanja javite u roku od 8 dana.</p>}
      >
        <DocTable
          head={[
            '#',
            'Serijski broj',
            'Kategorija',
            'Model',
            'Kod klijenta od',
            ...(sheet.rentals ? ['Ugovor'] : []),
            'Jamstvo do',
            shownView === 'prodano' || !sheet.rentals ? 'Cijena' : shownView === 'sve' ? 'Mjesečno / cijena' : 'Mjesečno',
          ]}
          align={['right', 'left', 'left', 'left', 'left', ...(sheet.rentals ? (['left'] as const) : []), 'left', 'right']}
          rows={rows.map((d, i) => [
            pg.skip + i + 1,
            <span key="s" className="font-mono">
              {d.serial}
            </span>,
            d.category ?? '—',
            d.model,
            formatDate(d.since),
            ...(sheet.rentals ? [d.contract ?? '—'] : []),
            formatDate(d.warrantyEnd),
            d.monthly !== null ? `${amount(d.monthly)} / mj` : d.price !== null ? amount(d.price) : '—',
          ])}
        />
        {!rows.length && <p className="mt-3 text-center text-black/60">Nema uređaja za prikaz.</p>}
        {rows.length > 0 && (
          <table className="ml-auto mt-3 min-w-[45%] text-[12px]">
            <tbody>
              {rent && (
                <tr className="border-t border-black/40 font-bold">
                  <td className="py-0.5 pr-6">Ukupno mjesečno</td>
                  <td className="py-0.5 text-right tnum">{amount(sheet.monthly)} EUR</td>
                </tr>
              )}
              {shownView !== 'najam' && sheet.sales > 0 && (
                <tr>
                  <td className="py-0.5 pr-6">Prodajne cijene ukupno</td>
                  <td className="py-0.5 text-right tnum">{amount(sheet.sales)} EUR</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {sheet.contracts.length > 0 && rent && (
          <div className="mt-5">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-black/50">Uvjeti ugovora</p>
            {sheet.contracts.map((c) => (
              <p key={c.id} className="text-[11px] leading-relaxed">
                <b className="font-mono">{c.number}</b> · {formatDate(c.startDate)}
                {c.endDate ? ` – ${formatDate(c.endDate)}` : ' – bez roka'} · naplata {BILLING_LABEL[c.billing].toLowerCase()}
                {c.seasonFrom ? ` · sezona ${seasonLabel(c.seasonFrom, c.seasonTo)}` : ''} · {integer(c.devices)} uređaja · {amount(c.monthly)} EUR mjesečno
                {c.status !== 'ACTIVE' ? ` · ${CONTRACT_STATUS_LABEL[c.status].toLowerCase()}` : ''}
              </p>
            ))}
          </div>
        )}
      </DocumentShell>
    </>
  );
}
