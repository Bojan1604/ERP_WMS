import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getLookups, modelLabel } from '@/server/queries/lookups';
import { getOrder, lastCosts, supplierOptions } from '@/server/queries/purchasing';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { PageHeader } from '@/components/ui/misc';
import { OrderForm } from '@/components/purchasing/order-form';
import { saveOrderAction } from '../../actions';

export default async function EditOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('purchasing', 'edit');
  const { id } = await params;
  const order = await getOrder(user.companyId, id);
  if (!order) notFound();
  if (order.status === 'RECEIVED' || order.status === 'CANCELLED') redirect(`/nabava/narudzbenice/${id}`);
  const [lookups, suppliers, costs] = await Promise.all([getLookups(user.companyId), supplierOptions(user.companyId, order.supplierId), lastCosts(user.companyId)]);
  const models = lookups.models.map((m) => ({ value: m.id, label: modelLabel(m), cost: costs.get(m.id) ?? 0 }));
  // model koji više nije aktivan, a na stavci je
  for (const l of order.lines) if (!models.some((m) => m.value === l.modelId)) models.push({ value: l.modelId, label: modelLabel(l.model), cost: 0 });

  return (
    <>
      <PageHeader
        title={`Izmjena narudžbenice ${order.number}`}
        back={
          <Link prefetch={false} href={`/nabava/narudzbenice/${id}`} className="hover:text-fg">
            ← {order.number}
          </Link>
        }
      />
      <OrderForm
        initial={{
          id: order.id,
          supplierId: order.supplierId,
          date: toISO(order.date),
          expectedDate: order.expectedDate ? toISO(order.expectedDate) : null,
          note: order.note,
          lines: order.lines.map((l) => ({ id: l.id, modelId: l.modelId, qty: l.qty, unitCost: num(l.unitCost), received: l.received })),
        }}
        suppliers={suppliers.map((s) => ({ value: s.id, label: s.name }))}
        models={models}
        action={saveOrderAction}
        cancelHref={`/nabava/narudzbenice/${id}`}
      />
    </>
  );
}
