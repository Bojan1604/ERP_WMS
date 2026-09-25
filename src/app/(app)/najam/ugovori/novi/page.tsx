import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { partnerOptionsByIds } from '@/server/queries/partner-options';
import { Card, Notice, PageHeader } from '@/components/ui/misc';
import { ContractForm } from '@/components/rentals/contract-form';
import { today } from '@/domain/dates';

export const metadata = { title: 'Novi ugovor' };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function NewContractPage({ searchParams }: { searchParams: SP }) {
  const user = await pageAccess('rentals', 'edit');
  const params = await searchParams;
  const ids = typeof params.items === 'string' ? params.items.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500) : [];
  const partnerParam = typeof params.partner === 'string' ? params.partner : null;
  const [[partner], items] = await Promise.all([
    partnerOptionsByIds(user.companyId, [partnerParam]),
    ids.length
      ? db.item.findMany({ where: { id: { in: ids }, companyId: user.companyId, contractItem: { is: null } }, select: { id: true, serial: true } })
      : Promise.resolve([]),
  ]);
  const t = today();

  return (
    <>
      <PageHeader
        title="Novi ugovor o najmu"
        back={
          <Link prefetch={false} href="/najam/ugovori" className="link">
            ← Ugovori
          </Link>
        }
      />
      {ids.length > 0 && (
        <Notice tone="info">
          Nakon otvaranja ugovora dodaju se odabrani uređaji ({items.length}): {items.slice(0, 8).map((i) => i.serial).join(', ')}
          {items.length > 8 ? '…' : ''}
          {items.length < ids.length ? ` — ${ids.length - items.length} ih je već na ugovoru ili ne postoji.` : ''}
        </Notice>
      )}
      <Card className="max-w-4xl">
        <ContractForm
          mode="create"
          partner={partner ?? null}
          items={items.map((i) => i.id)}
          initial={{
            startDate: t,
            endDate: null,
            firstBillingDate: null,
            // prazno = dan prve naplate (kao u pomoći polja)
            billingDay: null,
            billing: 'MONTHLY',
            billingMode: 'IN_ADVANCE',
            seasonFrom: null,
            seasonTo: null,
            note: null,
          }}
        />
      </Card>
    </>
  );
}
