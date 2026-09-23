import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { getPartner, partnerDevices } from '@/server/queries/partners';
import { DocumentShell, DocTable } from '@/components/doc/document';
import { PrintButton } from '@/components/ui/print-button';
import { PageHeader } from '@/components/ui/misc';
import { warrantyEnd } from '@/domain/pricing';
import { formatDate, toISO, today } from '@/domain/dates';

export const metadata = { title: 'Popis uređaja' };

/** Popis uređaja kod klijenta — za ispis ili PDF. */
export default async function PartnerDevicesDoc({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('partners');
  const { id } = await params;
  const [partner, company, devices] = await Promise.all([getPartner(user.companyId, id), getCompany(user.companyId), partnerDevices(user.companyId, id)]);
  if (!partner) notFound();
  const now = today();
  return (
    <>
      <div className="no-print">
        <PageHeader
          back={
            <Link prefetch={false} href={`/partneri/${id}?tab=uredaji`} className="hover:underline">
              ← {partner.name}
            </Link>
          }
          title="Popis uređaja za klijenta"
          actions={<PrintButton />}
        />
      </div>
      <DocumentShell
        company={company}
        title="Popis uređaja"
        meta={[
          ['Datum', formatDate(now)],
          ['Broj uređaja', String(devices.total)],
        ]}
        party={partner}
        partyLabel="Klijent"
        signatures={['Za ' + company.name, 'Klijent']}
      >
        <DocTable
          head={['#', 'Serijski broj', 'Model', 'Status', 'Od', 'Jamstvo do']}
          align={['right', 'left', 'left', 'left', 'left', 'left']}
          rows={devices.rows.map((d, i) => [
            i + 1,
            <span key="s" className="font-mono">{d.serial}</span>,
            [d.model.brand, d.model.name].filter(Boolean).join(' '),
            d.contractItem ? `${d.status.name} (${d.contractItem.contract.number})` : d.status.name,
            formatDate(d.issueDate),
            formatDate(warrantyEnd(d.warrantyStart ? toISO(d.warrantyStart) : null, d.warrantyMonths)),
          ])}
        />
        <p className="mt-4 text-[11px] text-black/60">Stanje na dan {formatDate(now)}. Molimo da odstupanja javite u roku od 8 dana.</p>
      </DocumentShell>
    </>
  );
}
