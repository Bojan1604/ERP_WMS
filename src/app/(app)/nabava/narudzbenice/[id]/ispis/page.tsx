import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany, modelLabel } from '@/server/queries/lookups';
import { getOrder } from '@/server/queries/purchasing';
import { num, r2 } from '@/domain/money';
import { DocTable, DocTotals, DocumentShell, docDate } from '@/components/doc/document';
import { PrintButton } from '@/components/ui/print-button';
import { amount } from '@/lib/format';
import { canSeeCost } from '@/domain/permissions';

export default async function OrderPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('purchasing', 'view');
  const { id } = await params;
  const [order, company] = await Promise.all([getOrder(user.companyId, id), getCompany(user.companyId)]);
  if (!order) notFound();
  // bez prava na nabavne cijene ispis je bez cijena i iznosa (kao PDF izvoz)
  const costs = canSeeCost(user.perms);

  return (
    <>
      <div className="no-print mb-4 flex items-center justify-between">
        <Link prefetch={false} href={`/nabava/narudzbenice/${id}`} className="text-sm text-fg-3 hover:text-fg">
          ← Narudžbenica {order.number}
        </Link>
        <PrintButton />
      </div>
      <DocumentShell
        company={company}
        title="Narudžbenica"
        number={order.number}
        meta={[
          ['Datum', docDate(order.date)],
          ...(order.expectedDate ? ([['Očekivana isporuka', docDate(order.expectedDate)]] as Array<[string, string]>) : []),
        ]}
        party={order.supplier}
        partyLabel="Dobavljač"
        signatures={['Naručio', 'Odobrio']}
        footer={<p>Molimo potvrdu narudžbe i rok isporuke. Na računu navedite broj narudžbenice {order.number}.</p>}
      >
        <DocTable
          head={['R. br.', 'Šifra', 'Naziv', 'Kol.', ...(costs ? ['Jed. cijena', 'Iznos'] : [])]}
          align={['left', 'left', 'left', 'right', ...(costs ? (['right', 'right'] as const) : [])]}
          rows={order.lines.map((l, i) => [
            `${i + 1}.`,
            l.model.code ?? '',
            modelLabel(l.model),
            `${l.qty} kom`,
            ...(costs ? [amount(num(l.unitCost)), amount(r2(l.qty * num(l.unitCost)))] : []),
          ])}
        />
        {costs && <DocTotals rows={[['Ukupno bez PDV-a (EUR)', amount(num(order.total)), true]]} />}
        {order.note && <p className="mt-6 whitespace-pre-line">{order.note}</p>}
      </DocumentShell>
    </>
  );
}
