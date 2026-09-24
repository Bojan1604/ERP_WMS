import Link from 'next/link';
import { QrCode, Smartphone } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { listDevices, orgOptions, parseDeviceFilters, profileOptions, siteOptions } from '@/server/queries/mdm';
import { can } from '@/domain/permissions';
import { ALERT_LABEL, deviceAlerts, PLATFORM_LABEL, type Platform } from '@/domain/mdm';
import { Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { FilterBar, SearchFilter, SegmentFilter, SelectFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { SelectAll, SelectableTr, SelectionProvider, SelectRow } from '@/components/ui/selection';
import { LinkButton } from '@/components/ui/button';
import { DeviceBulkBar } from '@/components/mdm/device-bulk-bar';
import { Ago, AlertBadges, Battery, DEVICE_STATUS_LABEL, DeviceStatusBadge, OnlineBadge, orgPath, PlatformIcon } from '@/components/mdm/common';
import { cn } from '@/lib/cn';
import { integer } from '@/lib/format';

export const metadata = { title: 'MDM uređaji' };

type Params = Record<string, string | string[] | undefined>;
const FILTER_KEYS = ['q', 'org', 'site', 'platform', 'status', 'online', 'alert', 'profile'];

function hrefWith(sp: Params, patch: Record<string, string | null>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v && k !== 'page') q.set(k, v);
  for (const [k, v] of Object.entries(patch)) (v ? q.set(k, v) : q.delete(k));
  const s = q.toString();
  return s ? `/mdm/uredaji?${s}` : '/mdm/uredaji';
}

export default async function MdmDevicesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const sp = await searchParams;
  const f = parseDeviceFilters(sp);
  const pg = readPage(sp, 50);
  const [list, orgs, sites, profiles] = await Promise.all([listDevices(scope, f, pg), orgOptions(scope), siteOptions(scope), profileOptions(scope)]);
  const now = new Date();
  const canOps = can(user.perms, 'mdm', 'ops');
  const canEdit = can(user.perms, 'mdm', 'edit');
  const filtered = FILTER_KEYS.some((k) => typeof sp[k] === 'string' && sp[k]);
  const allCount = Object.values(list.counts).reduce((a, b) => a + (b ?? 0), 0);
  const siteList = f.orgId ? sites.filter((s) => s.orgId === f.orgId || orgs.find((o) => o.id === s.orgId)?.parentId === f.orgId) : sites;

  return (
    <>
      <PageHeader
        title="Uređaji"
        subtitle="Windows računala, Android računala i ručni terminali"
        actions={
          canEdit && (
            <LinkButton href="/mdm/upis" variant="primary" icon={<QrCode className="size-4" />}>
              Upiši uređaj
            </LinkButton>
          )
        }
      />

      <div className="no-print mb-3 flex flex-wrap gap-1.5">
        <Link prefetch={false} href={hrefWith(sp, { status: null })} className={chip(!f.status)}>
          Svi <span className="tnum opacity-70">{integer(allCount)}</span>
        </Link>
        {(['ENROLLED', 'PENDING', 'RETIRED'] as const)
          .filter((s) => list.counts[s] || f.status === s)
          .map((s) => (
            <Link prefetch={false} key={s} href={hrefWith(sp, { status: f.status === s ? null : s })} className={chip(f.status === s)}>
              {DEVICE_STATUS_LABEL[s]} <span className="tnum opacity-70">{integer(list.counts[s] ?? 0)}</span>
            </Link>
          ))}
      </div>

      <FilterBar>
        <SearchFilter placeholder="Naziv, serijski, model, IP, IMEI…" />
        <SegmentFilter
          name="online"
          options={[
            { value: '', label: 'Svi' },
            { value: 'online', label: 'Online' },
            { value: 'offline', label: 'Offline' },
          ]}
        />
        <div className="grid w-full grid-cols-2 gap-2 sm:contents">
          {orgs.length > 1 && <SelectFilter name="org" placeholder="Sve organizacije" options={orgs.map((o) => ({ value: o.id, label: o.label }))} />}
          {siteList.length > 0 && <SelectFilter name="site" placeholder="Sve lokacije" options={siteList.map((s) => ({ value: s.id, label: s.name }))} />}
          <SelectFilter name="platform" placeholder="Sve platforme" options={Object.entries(PLATFORM_LABEL).map(([value, label]) => ({ value, label }))} />
          <SelectFilter
            name="alert"
            placeholder="Upozorenja"
            options={[{ value: 'any', label: 'Sva upozorenja' }, ...Object.entries(ALERT_LABEL).map(([value, label]) => ({ value, label }))]}
          />
          {profiles.length > 0 && <SelectFilter name="profile" placeholder="Sve konfiguracije" options={profiles.map((p) => ({ value: p.id, label: p.name }))} />}
        </div>
        {filtered && (
          <Link prefetch={false} href="/mdm/uredaji" className="text-sm text-fg-3 hover:text-fg">
            Očisti filtre
          </Link>
        )}
      </FilterBar>

      <SelectionProvider ids={list.rows.map((r) => r.id)}>
        {canOps && (
          <DeviceBulkBar
            platforms={Object.fromEntries(list.rows.map((r) => [r.id, r.platform as Platform]))}
            canEdit={canEdit}
            orgs={orgs.filter((o) => o.active).map((o) => ({ id: o.id, label: o.label }))}
            sites={sites}
            profiles={profiles.map((p) => ({ id: p.id, name: p.name, platform: p.platform as Platform }))}
          />
        )}
        <TableWrap>
          {list.rows.length ? (
            <table className="data-table min-w-[1100px] max-sm:min-w-0">
              <thead>
                <tr>
                  <th className="w-8">{canOps && <SelectAll />}</th>
                  <th>Naziv</th>
                  <th className="w-8"><span className="sr-only">Platforma</span></th>
                  <th>Organizacija › lokacija</th>
                  <th>Model</th>
                  <th>OS</th>
                  <th>Agent</th>
                  <th>Baterija</th>
                  <th>Zadnje javljanje</th>
                  <th>Stanje</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => {
                  const alerts = deviceAlerts(r, now);
                  return (
                    <SelectableTr key={r.id} id={r.id}>
                      <td>{canOps && <SelectRow id={r.id} />}</td>
                      <td>
                        <Link prefetch={false} href={`/mdm/uredaji/${r.id}`} className="link font-medium">
                          {r.name}
                        </Link>
                        {r.serial && <div className="font-mono text-xs text-fg-3">{r.serial}</div>}
                        {alerts.length > 0 && (
                          <div className="mt-0.5">
                            <AlertBadges alerts={alerts} />
                          </div>
                        )}
                      </td>
                      <td>
                        <PlatformIcon platform={r.platform} />
                      </td>
                      <td className="max-w-64">
                        <span className="text-fg-2">{orgPath(r.org)}</span>
                        {r.site && <span className="text-fg-3"> › {r.site.name}</span>}
                      </td>
                      <td className="whitespace-nowrap">{[r.manufacturer, r.model].filter(Boolean).join(' ') || '—'}</td>
                      <td className="whitespace-nowrap text-fg-2">{r.osVersion ?? '—'}</td>
                      <td className="whitespace-nowrap font-mono text-sm text-fg-2">{r.agentVersion ?? '—'}</td>
                      <td>
                        <Battery level={r.batteryLevel} charging={r.charging} />
                      </td>
                      <td className="text-fg-2">
                        <Ago at={r.lastSeenAt} now={now} />
                      </td>
                      <td className="whitespace-nowrap">
                        {r.status === 'ENROLLED' ? <OnlineBadge lastSeenAt={r.lastSeenAt} now={now} /> : <DeviceStatusBadge status={r.status} />}
                        {r.status === 'PENDING' && r.enrollCode && <span className="ml-1.5 font-mono text-sm text-fg-3">{r.enrollCode}</span>}
                      </td>
                    </SelectableTr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty
              icon={<Smartphone className="size-5" />}
              title={filtered ? 'Nema uređaja za zadane filtre' : 'Još nema uređaja'}
              description={filtered ? 'Promijenite ili očistite filtre.' : 'Instalirajte agenta na uređaj i upišite ga kodom s njegova zaslona.'}
              action={!filtered && canEdit ? <LinkButton href="/mdm/upis" variant="primary">Upis uređaja</LinkButton> : undefined}
            />
          )}
        </TableWrap>
      </SelectionProvider>
      <Pagination page={pg.page} pageSize={pg.pageSize} total={list.total} params={sp} basePath="/mdm/uredaji" />
    </>
  );
}

function chip(active: boolean) {
  return cn(
    'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm transition-colors',
    active ? 'bg-brand text-white' : 'bg-panel text-fg-2 shadow-[var(--shadow-panel)] hover:bg-muted',
  );
}
