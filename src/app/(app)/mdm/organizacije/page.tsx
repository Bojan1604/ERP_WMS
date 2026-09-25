import Link from 'next/link';
import { Building2, MapPin } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getMdmScope } from '@/server/mdm/scope';
import { orgTree } from '@/server/queries/mdm';
import { can } from '@/domain/permissions';
import { Badge, Card, Empty, PageHeader } from '@/components/ui/misc';
import { OrgDialog } from '@/components/mdm/org-forms';
import { emptyOrg, ORG_TYPE_LABEL } from '@/components/mdm/common';
import { cn } from '@/lib/cn';
import { integer } from '@/lib/format';

export const metadata = { title: 'MDM organizacije' };

type Org = Awaited<ReturnType<typeof orgTree>>['orgs'][number];

export default async function OrgsPage() {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const canEdit = can(user.perms, 'mdm', 'edit');
  const tree = await orgTree(scope);
  const home = scope.homeOrgId ? tree.orgs.find((o) => o.id === scope.homeOrgId) : null;
  const isDistributor = home?.type === 'DISTRIBUTOR';
  const canCreate = canEdit && (scope.owner || isDistributor);
  const distributors = tree.orgs.filter((o) => o.type === 'DISTRIBUTOR').map((o) => ({ id: o.id, name: o.name }));
  const devicesTotal = scope.owner ? await db.mdmDevice.count({ where: { companyId: scope.companyId, orgId: null } }) : 0;

  return (
    <>
      <PageHeader
        title="Organizacije"
        subtitle={scope.owner ? 'Distributeri, njihovi klijenti i lokacije' : isDistributor ? 'Vaša organizacija, klijenti i lokacije' : 'Vaša organizacija i lokacije'}
        actions={
          canCreate && (
            <>
              {scope.owner && <OrgDialog label="Novi distributer" owner value={emptyOrg('DISTRIBUTOR', null)} distributors={distributors} variant="secondary" />}
              <OrgDialog label="Novi klijent" owner={scope.owner} value={emptyOrg('CUSTOMER', scope.owner ? null : scope.homeOrgId)} distributors={distributors} />
            </>
          )
        }
      />
      {scope.owner && devicesTotal > 0 && (
        <p className="mb-3 text-sm text-fg-3">
          Uređaja bez organizacije (čekaju upis): <Link prefetch={false} href="/mdm/upis" className="link">{integer(devicesTotal)}</Link>
        </p>
      )}
      {tree.roots.length ? (
        <div className="space-y-3">
          {tree.roots.map((o) => (
            <Card key={o.id} padded={false}>
              <OrgNode org={o} depth={0} childrenOf={tree.children} />
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon={<Building2 className="size-5" />} title="Još nema organizacija" description="Otvorite distributera ili klijenta, pa lokacije na kojima su uređaji." />
        </Card>
      )}
    </>
  );
}

function OrgNode({ org, depth, childrenOf }: { org: Org; depth: number; childrenOf: Record<string, Org[]> }) {
  const kids = childrenOf[org.id] ?? [];
  return (
    <div className={cn(depth > 0 && 'border-t border-line')}>
      <div className={cn('flex flex-wrap items-center justify-between gap-2 px-4 py-2.5', depth > 0 && 'pl-8 max-sm:pl-6')}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link prefetch={false} href={`/mdm/organizacije/${org.id}`} className={cn('link', depth === 0 ? 'text-md font-semibold' : 'font-medium')}>
              {org.name}
            </Link>
            <Badge tone={org.type === 'DISTRIBUTOR' ? 'brand' : 'neutral'}>{ORG_TYPE_LABEL[org.type]}</Badge>
            {!org.active && <Badge tone="warn">neaktivna</Badge>}
          </div>
          <div className="mt-0.5 text-sm text-fg-3">
            {[org.city, org.oib && `OIB ${org.oib}`].filter(Boolean).join(' · ') || ' '}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-fg-2">
          <Link prefetch={false} href={`/mdm/uredaji?org=${org.id}`} className="hover:underline">
            Uređaja: <b className="tnum">{integer(org._count.devices)}</b>
          </Link>
          <span>
            Korisnika: <b className="tnum">{integer(org._count.users)}</b>
          </span>
          {org.type === 'DISTRIBUTOR' && (
            <span>
              Klijenata: <b className="tnum">{integer(org._count.children)}</b>
            </span>
          )}
        </div>
      </div>
      {org.sites.length > 0 && (
        <ul className={cn('flex flex-wrap gap-1.5 px-4 pb-2.5', depth > 0 && 'pl-8 max-sm:pl-6')}>
          {org.sites.map((s) => (
            <li key={s.id}>
              <Link prefetch={false} href={`/mdm/uredaji?site=${s.id}`} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-sm text-fg-2 hover:text-fg">
                <MapPin className="size-3.5" />
                {s.name}
                <span className="tnum text-fg-3">{s._count.devices}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {kids.map((k) => (
        <OrgNode key={k.id} org={k} depth={depth + 1} childrenOf={childrenOf} />
      ))}
    </div>
  );
}
