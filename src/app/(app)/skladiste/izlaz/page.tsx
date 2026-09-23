import { pageAccess } from '@/server/auth';
import { getLookups } from '@/server/queries/lookups';
import { outCounts } from '@/server/queries/warehouse';
import { can } from '@/domain/permissions';
import { PageHeader } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { ManualReturnSection, ReservedSection, ReturningSection, ReturnSection } from '@/components/warehouse/out-sections';

type Params = Record<string, string | string[] | undefined>;

export default async function OutPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('warehouse', 'view');
  const sp = await searchParams;
  const tab = typeof sp.tab === 'string' ? sp.tab : '';
  const q = typeof sp.q === 'string' && sp.q.trim() ? sp.q.trim() : null;
  const c = user.companyId;
  const [counts, lookups] = await Promise.all([outCounts(c), getLookups(c)]);
  const canOps = can(user.perms, 'warehouse', 'ops');

  return (
    <>
      <PageHeader title="Izlaz i povrat" subtitle="Uređaji koji su izašli iz skladišta i oprema koja se vraća s terena" />
      <Tabs
        param="tab"
        tabs={[
          { href: '/skladiste/izlaz', label: 'Izašlo iz skladišta', count: counts.reserved },
          { href: '/skladiste/izlaz?tab=povrat', label: 'Za povrat' },
          { href: '/skladiste/izlaz?tab=dolazak', label: 'U dolasku', count: counts.returning },
          { href: '/skladiste/izlaz?tab=rucni', label: 'Ručni povrat' },
        ]}
      />
      {tab === 'povrat' ? (
        <ReturnSection companyId={c} canOps={canOps} />
      ) : tab === 'dolazak' ? (
        <ReturningSection companyId={c} canOps={canOps} warehouses={lookups.warehouses.map((w) => ({ value: w.id, label: w.name }))} />
      ) : tab === 'rucni' ? (
        <ManualReturnSection companyId={c} canOps={canOps} q={q} />
      ) : (
        <ReservedSection companyId={c} canOps={canOps} canSell={can(user.perms, 'sales', 'edit')} canRent={can(user.perms, 'rentals', 'edit')} />
      )}
    </>
  );
}
