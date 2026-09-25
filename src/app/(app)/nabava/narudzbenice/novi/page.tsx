import Link from 'next/link';
import { redirect } from 'next/navigation';
import { canSeeCost } from '@/domain/permissions';
import { pageAccess } from '@/server/auth';
import { getLookups, modelLabel } from '@/server/queries/lookups';
import { lastCosts } from '@/server/queries/purchasing';
import { partnerOptionsByIds } from '@/server/queries/partner-options';
import { today } from '@/domain/dates';
import { PageHeader } from '@/components/ui/misc';
import { OrderForm, type OrderFormLine } from '@/components/purchasing/order-form';
import { saveOrderAction } from '../actions';

type Params = Record<string, string | string[] | undefined>;

export default async function NewOrderPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('purchasing', 'edit');
  // narudžbenica su nabavne cijene — upis i izmjena samo uz pravo na nabavne cijene (costs)
  if (!canSeeCost(user.perms)) redirect('/zabranjeno?modul=costs');
  const sp = await searchParams;
  const [lookups, [supplier], costs] = await Promise.all([
    getLookups(user.companyId),
    partnerOptionsByIds(user.companyId, [typeof sp.supplier === 'string' ? sp.supplier : null]),
    lastCosts(user.companyId),
  ]);
  const models = lookups.models.map((m) => ({ value: m.id, label: modelLabel(m), cost: costs.get(m.id) ?? 0 }));
  const known = new Set(models.map((m) => m.value));

  // ?lines=modelId:kol,modelId:kol — prijedlog iz panela „Niska zaliha"
  const prefill: OrderFormLine[] = (typeof sp.lines === 'string' ? sp.lines.split(',') : [])
    .map((p) => p.split(':'))
    .filter(([id]) => known.has(id))
    .map(([id, qty]) => ({ modelId: id, qty: Math.max(1, Number(qty) || 1), unitCost: costs.get(id) ?? 0 }));
  const supplierId = supplier?.id ?? null;

  return (
    <>
      <PageHeader
        title="Nova narudžbenica"
        back={
          <Link prefetch={false} href="/nabava/narudzbenice" className="hover:text-fg">
            ← Narudžbenice
          </Link>
        }
      />
      <OrderForm
        initial={{ supplierId, date: today(), expectedDate: null, note: null, lines: prefill.length ? prefill : [{ modelId: '', qty: 1, unitCost: 0 }] }}
        supplier={supplier ?? null}
        models={models}
        action={saveOrderAction}
        cancelHref="/nabava/narudzbenice"
      />
    </>
  );
}
