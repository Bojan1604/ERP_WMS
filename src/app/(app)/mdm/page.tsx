import Link from 'next/link';
import { MonitorSmartphone, QrCode } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { mdmDashboard } from '@/server/queries/mdm';
import { can } from '@/domain/permissions';
import { deviceAlerts } from '@/domain/mdm';
import { Badge, Card, Empty, PageHeader, Stat } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { Ago, AlertBadges, EVENT_LEVEL_TONE, ORG_TYPE_LABEL, orgPath, PlatformIcon } from '@/components/mdm/common';
import { AutoRefresh } from '@/components/mdm/commands-refresh';
import { integer } from '@/lib/format';

export const metadata = { title: 'MDM — pregled' };

export default async function MdmDashboardPage() {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const now = new Date();
  const d = await mdmDashboard(scope, now);
  const canEdit = can(user.perms, 'mdm', 'edit');
  const showOrgs = d.perOrg.length > 1;
  const link = (qs: string) => `/mdm/uredaji?${qs}`;

  return (
    <>
      <AutoRefresh active seconds={60} />
      <PageHeader
        title="Pregled uređaja"
        subtitle={user.mdmOrgName ?? 'Upravljanje uređajima (MDM)'}
        actions={
          canEdit && (
            <LinkButton href="/mdm/upis" variant="primary" icon={<QrCode className="size-4" />}>
              Upiši uređaj
            </LinkButton>
          )
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Link prefetch={false} href={link('status=ENROLLED')}>
          <Stat label="Upisano" value={integer(d.enrolled)} hint={`Android ${d.platform.ANDROID ?? 0} · Windows ${d.platform.WINDOWS ?? 0}`} />
        </Link>
        <Link prefetch={false} href={link('online=online')}>
          <Stat label="Online" value={integer(d.online)} tone="ok" hint={d.enrolled ? `${Math.round((d.online / d.enrolled) * 100)} % upisanih` : undefined} />
        </Link>
        <Link prefetch={false} href={link('online=offline')}>
          <Stat label="Offline" value={integer(d.offline)} tone={d.offline ? 'bad' : undefined} />
        </Link>
        <Link prefetch={false} href={link('alert=any')}>
          <Stat label="Upozorenja" value={integer(d.alertCount)} tone={d.alertCount ? 'warn' : undefined} />
        </Link>
        <Link prefetch={false} href={canEdit ? '/mdm/upis' : link('status=PENDING')}>
          <Stat label="Čeka upis" value={integer(d.pending)} tone={d.pending ? 'warn' : undefined} />
        </Link>
        <Link prefetch={false} href={link('status=RETIRED')}>
          <Stat label="Odjavljeno" value={integer(d.retired)} />
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          <Card
            title="Upozorenja"
            padded={false}
            actions={
              d.alertCount > d.alerts.length && (
                <Link prefetch={false} href={link('alert=any')} className="text-sm link">
                  Svih {integer(d.alertCount)} →
                </Link>
              )
            }
          >
            {d.alerts.length ? (
              <ul className="divide-y divide-line">
                {d.alerts.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <PlatformIcon platform={a.platform} />
                      <span className="min-w-0">
                        <Link prefetch={false} href={`/mdm/uredaji/${a.id}`} className="link font-medium">
                          {a.name}
                        </Link>
                        <span className="block truncate text-xs text-fg-3">
                          {orgPath(a.org)}
                          {a.site && ` › ${a.site.name}`} · javio se <Ago at={a.lastSeenAt} now={now} />
                        </span>
                      </span>
                    </span>
                    <AlertBadges alerts={deviceAlerts(a, now)} />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty icon={<MonitorSmartphone className="size-5" />} title="Nema upozorenja" description="Svi upisani uređaji se javljaju, imaju dovoljno baterije i prostora te primijenjenu konfiguraciju." />
            )}
          </Card>

          {showOrgs && (
            <Card title="Po organizacijama" padded={false}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Organizacija</th>
                    <th>Vrsta</th>
                    <th className="num">Upisano</th>
                    <th className="num">Online</th>
                    <th className="num">Offline</th>
                  </tr>
                </thead>
                <tbody>
                  {d.perOrg.map((o) => (
                    <tr key={o.id}>
                      <td className={o.parentId && d.perOrg.some((p) => p.id === o.parentId) ? 'pl-6' : undefined}>
                        <Link prefetch={false} href={link(`org=${o.id}`)} className="link">
                          {o.name}
                        </Link>
                      </td>
                      <td>
                        <Badge tone={o.type === 'DISTRIBUTOR' ? 'brand' : 'neutral'}>{ORG_TYPE_LABEL[o.type]}</Badge>
                      </td>
                      <td className="num">{integer(o.total)}</td>
                      <td className="num text-ok">{integer(o.online)}</td>
                      <td className={o.total - o.online ? 'num text-bad-strong' : 'num'}>{integer(o.total - o.online)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>

        <Card title="Nedavni događaji" padded={false}>
          {d.events.length ? (
            <ul className="divide-y divide-line">
              {d.events.map((e) => (
                <li key={e.id} className="px-4 py-2">
                  <div className="flex items-center justify-between gap-2 text-xs text-fg-3">
                    <Link prefetch={false} href={`/mdm/uredaji/${e.device.id}/dogadaji`} className="link truncate text-sm font-medium">
                      {e.device.name}
                    </Link>
                    <Ago at={e.at} now={now} />
                  </div>
                  <div className="mt-0.5 flex items-start gap-1.5 text-sm">
                    <Badge tone={EVENT_LEVEL_TONE[e.level] ?? 'neutral'}>{e.type}</Badge>
                    <span className="min-w-0 break-words text-fg-2">{e.message}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-sm text-fg-3">Još nema događaja.</p>
          )}
        </Card>
      </div>
    </>
  );
}
