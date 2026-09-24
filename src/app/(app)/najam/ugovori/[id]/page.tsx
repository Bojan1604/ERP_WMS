import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { can } from '@/domain/permissions';
import { contractItems, contractPending, getContract } from '@/server/queries/rentals';
import { toDevice } from '@/server/services/rentals';
import { Badge, PageHeader } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { ContractStatusBadge } from '@/components/rentals/badges';
import { ContractStatusActions } from '@/components/rentals/contract-actions';
import { OverviewTab } from './overview-tab';
import { DevicesTab } from './devices-tab';
import { ScheduleTab } from './schedule-tab';
import { InvoicesTab } from './invoices-tab';
import { HistoryTab } from './history-tab';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export const metadata = { title: 'Ugovor o najmu' };

export default async function ContractPage({ params, searchParams }: Props) {
  const user = await pageAccess('rentals', 'view');
  const { id } = await params;
  const sp = await searchParams;
  const c = await getContract(user.companyId, id);
  if (!c) notFound();
  const tab = typeof sp.tab === 'string' ? sp.tab : '';
  const items = await contractItems(c.id);
  const devices = items.map(toDevice);
  const pending = await contractPending(c, devices);
  const canEdit = can(user.perms, 'rentals', 'edit');
  const editable = c.status === 'ACTIVE' || c.status === 'PAUSED';
  const base = `/najam/ugovori/${c.id}`;

  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/najam/ugovori" className="link">
            ← Ugovori
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            Ugovor {c.number} <ContractStatusBadge status={c.status} />
            {c.partner.excluded && <Badge tone="warn">isključen partner</Badge>}
          </span>
        }
        subtitle={
          <>
            <Link prefetch={false} href={`/partneri/${c.partner.id}`} className="link">
              {c.partner.name}
            </Link>
            {c.partner.city ? ` · ${c.partner.city}` : ''}
          </>
        }
        actions={
          canEdit && editable ? (
            <ContractStatusActions id={c.id} number={c.number} status={c.status} rented={items.filter((i) => i.item.state === 'RENTED').length} pending={pending.length} />
          ) : undefined
        }
      />
      <Tabs
        param="tab"
        tabs={[
          { href: base, label: 'Pregled', count: pending.length || undefined },
          { href: `${base}?tab=uredaji`, label: 'Uređaji', count: items.length },
          { href: `${base}?tab=raspored`, label: 'Raspored' },
          { href: `${base}?tab=racuni`, label: 'Računi', count: c._count.invoices },
          { href: `${base}?tab=povijest`, label: 'Povijest' },
        ]}
      />
      {tab === 'uredaji' ? (
        <DevicesTab contract={c} items={items} canEdit={canEdit && editable} companyId={user.companyId} prefill={typeof sp.dodaj === 'string' ? sp.dodaj : ''} />
      ) : tab === 'raspored' ? (
        <ScheduleTab contract={c} items={items} year={Number(sp.godina) || undefined} canEdit={canEdit && editable} />
      ) : tab === 'racuni' ? (
        <InvoicesTab contract={c} companyId={user.companyId} params={sp} />
      ) : tab === 'povijest' ? (
        <HistoryTab contractId={c.id} companyId={user.companyId} />
      ) : (
        <OverviewTab
          contract={c}
          devices={devices}
          pending={pending}
          canEdit={canEdit && editable}
          canIssue={can(user.perms, 'sales', 'edit')}
          canSkip={canEdit}
        />
      )}
    </>
  );
}
