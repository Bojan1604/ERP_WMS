import Link from 'next/link';
import { notFound } from 'next/navigation';
import { portalPage } from '@/server/portal/auth';
import { portalDeliveryNote } from '@/server/portal/queries';
import { getCompany } from '@/server/queries/lookups';
import { DocumentShell } from '@/components/doc/document';
import { PrintButton } from '@/components/ui/print-button';
import { formatDate, today } from '@/domain/dates';

export const metadata = { title: 'Nalog za dostavu' };

/**
 * Nalog za dostavu — list koji klijent stavlja u paket s uređajem: broj
 * prijave, uređaj, serijski broj, kvar, pošiljatelj i adresa servisa.
 */
export default async function PortalDeliveryNotePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await portalPage();
  const { id } = await params;
  const [o, company] = await Promise.all([portalDeliveryNote(user, id), getCompany(user.companyId)]);
  if (!o) notFound();
  const device = o.item ? [o.item.model.brand, o.item.model.name].filter(Boolean).join(' ') : '—';
  const serviceAddress = [company.name, company.address, [company.zip, company.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return (
    <>
      <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-2">
        <Link prefetch={false} href={`/portal/prijave/${o.id}`} className="text-sm text-fg-3 hover:underline">
          ← Prijava {o.number}
        </Link>
        <PrintButton />
      </div>
      <DocumentShell
        company={company}
        title="Nalog za dostavu"
        number={o.number}
        meta={[
          ['Datum prijave', formatDate(o.reportedAt)],
          ['Ispisano', formatDate(today())],
        ]}
        party={o.partner}
        partyLabel="Pošiljatelj"
        signatures={['Predao (klijent)', 'Zaprimio (servis)']}
        footer={<p>Molimo da ovaj list priložite uz uređaj u paketu. Na paketu navedite broj prijave {o.number}.</p>}
      >
        <table className="w-full border-collapse text-[12px]">
          <tbody>
            {[
              ['Broj prijave', <b key="n" className="text-[16px]">{o.number}</b>],
              ['Uređaj', device],
              ['Serijski broj', <span key="s" className="font-mono text-[14px] font-semibold break-all">{o.item?.serial ?? o.serial ?? '—'}</span>],
              ['Jamstvo', o.underWarranty ? 'u jamstvu' : 'izvan jamstva — servis se naplaćuje'],
              ['Opis kvara', <span key="i" className="whitespace-pre-line">{o.issue}</span>],
              ['Kontakt za dogovor', o.contact || [user.name, user.email].filter(Boolean).join(', ')],
              ['Adresa servisa', serviceAddress],
            ].map(([k, v], i) => (
              <tr key={i} className="border-b border-black/15 align-top">
                <td className="w-40 py-2 pr-3 text-black/60">{k}</td>
                <td className="py-2">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentShell>
    </>
  );
}
