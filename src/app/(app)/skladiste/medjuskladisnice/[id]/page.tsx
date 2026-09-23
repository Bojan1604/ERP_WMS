import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany, modelLabel } from '@/server/queries/lookups';
import { getTransfer } from '@/server/queries/warehouse';
import { DocTable, DocumentShell, docDate } from '@/components/doc/document';
import { PageHeader } from '@/components/ui/misc';
import { PrintButton } from '@/components/ui/print-button';
import { PrintUnclip } from '@/components/warehouse/print-unclip';

export default async function TransferDocPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('warehouse', 'view');
  const { id } = await params;
  const [t, company] = await Promise.all([getTransfer(user.companyId, id), getCompany(user.companyId)]);
  if (!t) notFound();
  const where = (w: { name: string; address: string | null } | null) => (w ? [w.name, w.address].filter(Boolean).join(', ') : '—');
  return (
    <>
      <PrintUnclip />
      <div className="no-print">
        <PageHeader
          back={
            <Link prefetch={false} href="/skladiste/medjuskladisnice" className="hover:text-fg">
              ← Međuskladišnice
            </Link>
          }
          title={`Međuskladišnica ${t.number}`}
          subtitle={`${t.fromWarehouse?.name ?? '—'} → ${t.toWarehouse.name} · ${t.items.length} kom`}
          actions={<PrintButton />}
        />
      </div>
      <DocumentShell
        company={company}
        title="Međuskladišnica"
        number={t.number}
        meta={[
          ['Datum', docDate(t.date)],
          ['Izradio', t.createdBy ?? '—'],
        ]}
        signatures={['Izdao', 'Primio']}
      >
        <table className="mb-4 w-full text-[12px]">
          <tbody>
            <tr>
              <td className="w-1/2 pr-4 align-top">
                <p className="text-[10px] uppercase tracking-wider text-black/50">Iz skladišta</p>
                <p className="font-semibold">{where(t.fromWarehouse)}</p>
              </td>
              <td className="w-1/2 align-top">
                <p className="text-[10px] uppercase tracking-wider text-black/50">U skladište</p>
                <p className="font-semibold">{where(t.toWarehouse)}</p>
              </td>
            </tr>
          </tbody>
        </table>
        <DocTable
          head={['R.br.', 'Šifra', 'Model', 'Serijski broj']}
          align={['right', 'left', 'left', 'left']}
          rows={t.items.map(({ item }, i) => [
            `${i + 1}.`,
            item.model.code ?? '',
            modelLabel(item.model),
            <span key="s" className="font-mono">
              {item.serial}
              {item.dupNote ? ` (${item.dupNote})` : ''}
            </span>,
          ])}
        />
        <p className="mt-3 text-right font-semibold">Ukupno: {t.items.length} kom</p>
        {t.note && <p className="mt-4">Napomena: {t.note}</p>}
      </DocumentShell>
    </>
  );
}
