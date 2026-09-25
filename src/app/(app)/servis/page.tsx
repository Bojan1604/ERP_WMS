import Link from 'next/link';
import { Plus, Wrench } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { listServiceOrders, serviceModels, servicePartners } from '@/server/queries/service';
import { portalNewCount } from '@/server/portal/count';
import { queryWithout } from '@/lib/list-params';
import { modelLabel } from '@/server/queries/lookups';
import { can } from '@/domain/permissions';
import { daysBetween, toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { Badge, Empty, Notice, PageHeader, Stat, TableWrap } from '@/components/ui/misc';
import { FilterBar, MultiSelectFilter, SearchFilter, SegmentFilter, SelectFilter, ToggleFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { LinkButton } from '@/components/ui/button';
import { LONG_SERVICE_DAYS, SERVICE_STATUS, isOpenService } from '@/components/service/labels';
import { cn } from '@/lib/cn';
import { date, eur, integer } from '@/lib/format';
import { ExportButtons } from '@/components/ui/export-buttons';

type Params = Record<string, string | string[] | undefined>;
const FILTERS = ['q', 'status', 'scope', 'partner', 'warranty', 'long', 'model', 'izvor'];

export default async function ServicePage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('service', 'view');
  const sp = await searchParams;
  const pg = readPage(sp, 50);
  const [list, partners, models, portalNew] = await Promise.all([
    listServiceOrders(user.companyId, sp, pg),
    servicePartners(user.companyId),
    serviceModels(user.companyId),
    portalNewCount(user.companyId),
  ]);
  const showingPortal = (sp.izvor === '1' || sp.izvor === 'portal') && sp.status === 'REPORTED';
  const canEdit = can(user.perms, 'service', 'edit');
  const t = today();
  const filtered = FILTERS.some((k) => typeof sp[k] === 'string' && sp[k]);
  const qs = queryWithout(sp, ['page']);

  return (
    <>
      <PageHeader
        title="Servis (RMA)"
        subtitle="Servisni nalozi, reklamacije i zamjene uređaja"
        actions={
          <>
            <ExportButtons href={`/api/servis?${qs}`} />
            {canEdit && (
              <LinkButton href="/servis/novi" variant="primary" icon={<Plus className="size-4" />}>
                Novi nalog
              </LinkButton>
            )}
          </>
        }
      />

      {portalNew > 0 && !showingPortal && (
        <Notice
          tone="info"
          action={
            <LinkButton href="/servis?izvor=1&status=REPORTED&scope=all" size="sm">
              Prikaži prijave
            </LinkButton>
          }
        >
          {portalNew === 1 ? 'Jedna nova prijava kvara' : `${portalNew} novih prijava kvara`} s portala — otvorite nalog i promijenite status u
          „Zaprimljeno" kad uređaj stigne (ili dogovorite servis na licu mjesta).
        </Notice>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Naloga (filtrirano)" value={integer(list.total)} />
        <Stat label="Otvorenih" value={integer(list.stats.open)} />
        <Stat label={`Otvoreno dulje od ${LONG_SERVICE_DAYS} dana`} value={integer(list.stats.long)} tone={list.stats.long ? 'bad' : undefined} />
        <Stat label="Trošak popravaka" value={eur(list.stats.cost)} hint={`Izvan jamstva: ${integer(list.stats.noWarranty)} naloga`} />
      </div>

      <FilterBar>
        <SegmentFilter
          name="scope"
          options={[
            { value: '', label: 'Otvoreni' },
            { value: 'closed', label: 'Zatvoreni' },
            { value: 'all', label: 'Svi' },
          ]}
        />
        <SearchFilter placeholder="Broj, serijski, klijent, kvar…" />
        <SelectFilter name="status" placeholder="Svi statusi" options={Object.entries(SERVICE_STATUS).map(([value, s]) => ({ value, label: s.label }))} />
        <SelectFilter name="partner" placeholder="Svi klijenti" options={partners.map((p) => ({ value: p.id, label: p.name }))} />
        <MultiSelectFilter name="model" label="Model" options={models.map((m) => ({ value: m.id, label: modelLabel(m) }))} />
        <ToggleFilter name="izvor" label="Samo s portala" />
        <SelectFilter
          name="warranty"
          placeholder="Jamstvo: sve"
          options={[
            { value: 'yes', label: 'U jamstvu' },
            { value: 'no', label: 'Izvan jamstva' },
          ]}
        />
        <ToggleFilter name="long" label={`Dulje od ${LONG_SERVICE_DAYS} dana`} />
        {filtered && (
          <Link prefetch={false} href="/servis" className="text-sm text-fg-3 hover:text-fg">
            Očisti filtre
          </Link>
        )}
      </FilterBar>

      <TableWrap>
        {list.rows.length ? (
          <table className="data-table min-w-[1150px]">
            <thead>
              <tr>
                <th>Broj</th>
                <th>Serijski broj</th>
                <th>Model</th>
                <th>Klijent</th>
                <th>Kvar</th>
                <th>Status</th>
                <th>Prijavljeno</th>
                <th className="num">Dana</th>
                <th className="num">Trošak</th>
                <th>Jamstvo</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((o) => {
                const open = isOpenService(o.status);
                const days = daysBetween(toISO(o.reportedAt), o.closedAt ? toISO(o.closedAt) : t);
                const st = SERVICE_STATUS[o.status];
                return (
                  <tr key={o.id}>
                    <td>
                      <Link prefetch={false} href={`/servis/${o.id}`} className="link font-medium">
                        {o.number}
                      </Link>
                      {o.source === 'PORTAL' && (
                        <Badge className="ml-1.5" tone="brand" title="Prijava kvara s portala za klijente">
                          portal
                        </Badge>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {o.item ? (
                        <Link prefetch={false} href={`/skladiste/${o.item.id}`} className="link font-mono text-sm">
                          {o.serial}
                        </Link>
                      ) : (
                        <span className="font-mono text-sm">{o.serial ?? '—'}</span>
                      )}
                      {o.replacement && <span className="block text-xs text-fg-3">→ {o.replacement.serial}</span>}
                    </td>
                    <td>{o.item ? modelLabel(o.item.model) : '—'}</td>
                    <td className="max-w-48 truncate">{o.partner?.name ?? <span className="text-fg-4">—</span>}</td>
                    <td className="max-w-64 truncate text-fg-2" title={o.issue}>
                      {o.issue}
                    </td>
                    <td>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                    <td className="whitespace-nowrap">{date(o.reportedAt)}</td>
                    <td className={cn('num', open && days > LONG_SERVICE_DAYS && 'font-semibold text-bad-strong')}>{days}</td>
                    <td className="num">{num(o.cost) ? eur(num(o.cost)) : '—'}</td>
                    <td>{o.underWarranty ? <Badge tone="ok">da</Badge> : <Badge tone="warn">ne</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<Wrench className="size-5" />}
            title={filtered ? 'Nema naloga za zadane filtre' : 'Nema otvorenih servisnih naloga'}
            description="Nalog se otvara ručno ili automatski kad uređaj dobije status servisa."
          />
        )}
      </TableWrap>
      <Pagination page={pg.page} pageSize={pg.pageSize} total={list.total} params={sp} basePath="/servis" />
    </>
  );
}
