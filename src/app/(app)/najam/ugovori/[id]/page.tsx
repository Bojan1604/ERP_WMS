import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { can, canSeeCost } from '@/domain/permissions';
import { contractItems, contractPending, getContract } from '@/server/queries/rentals';
import { toDevice } from '@/server/services/rentals';
import { Badge, PageHeader } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { ContractStatusBadge } from '@/components/rentals/badges';
import { ContractStatusActions } from '@/components/rentals/contract-actions';
import { ContractDeleteButton } from '@/components/rentals/contract-delete';
import { ClientSheetButton } from '@/components/partners/client-sheet-link';
import { Attachments } from '@/components/ui/attachments';
import { db } from '@/server/db';
import { plain } from '@/server/plain';
import { getLookups } from '@/server/queries/lookups';
import { canAttachment, listAttachments } from '@/server/services/attachments';
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
  const canEdit = can(user.perms, 'rentals', 'edit');
  const [pending, files, lookups] = await Promise.all([
    contractPending(c, devices),
    listAttachments(db, user.companyId, 'contract', [c.id]),
    canEdit && !c._count.invoices ? getLookups(user.companyId) : null,
  ]);
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
          <>
            <ClientSheetButton partnerId={c.partner.id} contractId={c.id} />
            {canEdit && editable && (
              <ContractStatusActions id={c.id} number={c.number} status={c.status} rented={items.filter((i) => i.item.state === 'RENTED').length} pending={pending.length} />
            )}
            {canEdit && !c._count.invoices && lookups && (
              <ContractDeleteButton
                id={c.id}
                number={c.number}
                rented={items.filter((i) => i.item.state === 'RENTED').length}
                warehouses={lookups.warehouses.map((w) => ({ value: w.id, label: w.name }))}
              />
            )}
          </>
        }
      />
      <Tabs
        param="tab"
        tabs={[
          { href: base, label: 'Pregled', count: pending.length || undefined },
          { href: `${base}?tab=uredaji`, label: 'Uređaji', count: items.length },
          { href: `${base}?tab=raspored`, label: 'Raspored' },
          { href: `${base}?tab=racuni`, label: 'Računi', count: c._count.invoices },
          { href: `${base}?tab=pdf`, label: 'Ugovor (PDF)', count: files.length || undefined },
          { href: `${base}?tab=povijest`, label: 'Povijest' },
        ]}
      />
      {tab === 'uredaji' ? (
        <DevicesTab contract={c} items={items} canEdit={canEdit && editable} companyId={user.companyId} prefill={typeof sp.dodaj === 'string' ? sp.dodaj : ''} params={sp} showCost={canSeeCost(user.perms)} />
      ) : tab === 'raspored' ? (
        <ScheduleTab contract={c} items={items} year={Number(sp.godina) || undefined} canEdit={canEdit && editable} params={sp} />
      ) : tab === 'racuni' ? (
        <InvoicesTab contract={c} companyId={user.companyId} params={sp} />
      ) : tab === 'pdf' ? (
        <div className="max-w-3xl space-y-2">
          <p className="text-sm text-fg-3">Priložite potpisani ugovor (PDF ili sken). Vidljiv je i u popisu ugovora (stupac PDF).</p>
          <Attachments entity="contract" id={c.id} canEdit={canAttachment(user.perms, 'contract', 'add')} initial={plain(files)} empty="Potpisani ugovor još nije priložen." />
        </div>
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
