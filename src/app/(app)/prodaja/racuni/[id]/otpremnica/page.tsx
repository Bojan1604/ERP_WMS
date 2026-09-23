import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { getInvoice } from '@/server/queries/sales';
import { formatDate, toISO } from '@/domain/dates';
import { warrantyEnd } from '@/domain/pricing';
import { num } from '@/domain/money';
import { PageHeader } from '@/components/ui/misc';
import { PrintButton } from '@/components/ui/print-button';
import { DocumentShell, DocTable } from '@/components/doc/document';
import { decimal } from '@/lib/format';

export const metadata = { title: 'Otpremnica' };

/** Otpremnica uz izdani račun: serijski brojevi, jamstvo po uređaju, potpisi. */
export default async function DeliveryNotePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('sales', 'view');
  const { id } = await params;
  const [inv, company] = await Promise.all([getInvoice(user.companyId, id), getCompany(user.companyId)]);
  if (!inv) notFound();
  // usluge se ne otpremaju — na otpremnici su uređaji, modeli i ručne stavke
  const lines = inv.lines.filter((l) => l.kind !== 'SERVICE');
  const start = inv.lines.find((l) => l.item?.warrantyStart)?.item?.warrantyStart;
  const warrantyFrom = toISO(start ?? inv.date);

  return (
    <>
      <div className="no-print">
      <PageHeader
        title={`Otpremnica uz račun ${inv.number ?? '(nacrt)'}`}
        back={
          <Link prefetch={false} href={`/prodaja/racuni/${inv.id}`} className="hover:underline">
            ← Račun
          </Link>
        }
        actions={<PrintButton />}
      />
      </div>
      <DocumentShell
        company={company}
        title="Otpremnica"
        number={inv.number}
        meta={[
          ['Datum', formatDate(inv.deliveryDate ?? inv.date)],
          ['Uz račun', inv.number ?? '—'],
          ...(inv.issuedBy ? ([['Izdao', inv.issuedBy]] as Array<[string, string]>) : []),
        ]}
        party={inv.partner}
        partyLabel="Primatelj"
        signatures={['Robu izdao', 'Robu primio (ime, prezime, potpis)']}
        footer={<p>Jamstvo teče od datuma računa uz predočenje ovog dokumenta i računa.</p>}
      >
        <DocTable
          head={['#', 'Opis', 'Serijski broj', 'Kol.', 'Jed.', 'Jamstvo']}
          align={['left', 'left', 'left', 'right', 'left', 'left']}
          rows={lines.map((l, i) => {
            const months = l.kind === 'DEVICE' ? (l.warrantyMonths ?? l.item?.warrantyMonths ?? company.defaultWarrantyMonths) : null;
            const end = months ? warrantyEnd(warrantyFrom, months) : null;
            return [
              i + 1,
              l.description,
              l.item ? <span className="font-mono">{l.item.serial}</span> : '—',
              decimal(Math.abs(num(l.qty))),
              l.unit,
              months ? `${months} mj · do ${formatDate(end)}` : '—',
            ];
          })}
        />
        <p className="mt-3 text-[11px] text-black/60">
          Ukupno stavki: {lines.length}
          {lines.some((l) => l.item) && <> · uređaja: {lines.filter((l) => l.item).length}</>}
        </p>
      </DocumentShell>
    </>
  );
}
