import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { erpMatches, getDevice, orgOptions, profileOptions, siteOptions } from '@/server/queries/mdm';
import { can } from '@/domain/permissions';
import { deviceAlerts, isOnline, PLATFORM_LABEL, type Platform } from '@/domain/mdm';
import { Card, Detail, Notice } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { DeviceNotes, DevicePin } from '@/components/mdm/device-edit';
import { AssignProfileButton, MoveDevicesButton } from '@/components/mdm/device-assign';
import { DeviceErpCard } from '@/components/mdm/device-erp';
import { Ago, AlertBadges, Battery, mb, orgPath, uptime } from '@/components/mdm/common';
import { dateTime } from '@/lib/format';
import { extraLabel, extraValue } from '@/components/mdm/extra-labels';

export const metadata = { title: 'MDM uređaj' };

export default async function DeviceOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const { id } = await params;
  const d = await getDevice(scope, id);
  if (!d) notFound();
  const canEdit = can(user.perms, 'mdm', 'edit');
  const canOps = can(user.perms, 'mdm', 'ops');
  const [orgs, sites, profiles, matches] = await Promise.all([
    canEdit ? orgOptions(scope, { activeOnly: true }) : [],
    canEdit ? siteOptions(scope) : [],
    canEdit ? profileOptions(scope) : [],
    scope.owner ? erpMatches(scope.companyId, d.serial, d.itemId) : [],
  ]);
  const now = new Date();
  const online = isOnline(d.lastSeenAt, now);
  const alerts = deviceAlerts(d, now);
  const extra = ((d.telemetry as { extra?: Record<string, unknown> } | null)?.extra ?? {}) as Record<string, unknown>;
  const extraRows = Object.entries(extra).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').slice(0, 20);
  const storageUsedPct = d.storageTotalMb && d.storageFreeMb !== null ? Math.round(((d.storageTotalMb - d.storageFreeMb) / d.storageTotalMb) * 100) : null;
  const profileName = d.profile?.name ?? (d.site?.profile ? `${d.site.profile.name} (lokacija)` : null);

  return (
    <>
      {d.status === 'PENDING' && (
        <Notice
          tone="warn"
          action={canEdit && d.enrollCode ? <LinkButton href={`/mdm/upis?kod=${d.enrollCode}`} variant="primary" size="sm">Upiši uređaj</LinkButton> : undefined}
        >
          Uređaj čeka upis. Kod na zaslonu uređaja: <b className="font-mono text-md">{d.enrollCode ?? '—'}</b>
        </Notice>
      )}
      {d.status === 'RETIRED' && <Notice tone="neutral">Uređaj je odjavljen (Forget) i više ne prima naredbe.</Notice>}
      {alerts.length > 0 && (
        <div className="mb-3">
          <AlertBadges alerts={alerts} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card title="Stanje">
            <dl>
              <Detail label="ID uređaja">
                <span className="font-mono text-sm">{d.hardwareId ?? d.id}</span>
              </Detail>
              <Detail label="Vrsta / model">
                {PLATFORM_LABEL[d.platform as Platform]} · {d.model ?? '—'}
              </Detail>
              <Detail label="Proizvođač">{d.manufacturer}</Detail>
              <Detail label="Serijski broj">{d.serial ? <span className="font-mono text-sm">{d.serial}</span> : null}</Detail>
              {d.platform === 'ANDROID' && <Detail label="IMEI">{d.imei ? <span className="font-mono text-sm">{d.imei}</span> : null}</Detail>}
              <Detail label="Operacijski sustav">{d.osVersion}</Detail>
              <Detail label="Verzija agenta">{d.agentVersion ? <span className="font-mono text-sm">{d.agentVersion}</span> : null}</Detail>
              <Detail label="Veza">
                {d.status !== 'ENROLLED' ? (
                  <span className="text-fg-3">—</span>
                ) : online ? (
                  <span className="text-ok">online (od {dateTime(d.onlineSince ?? d.lastSeenAt)})</span>
                ) : (
                  <span className="text-bad-strong">offline {d.lastSeenAt ? `(od ${dateTime(d.lastSeenAt)})` : '(nije se javio)'}</span>
                )}
              </Detail>
              <Detail label="Zadnje javljanje">
                <Ago at={d.lastSeenAt} now={now} />
              </Detail>
              <Detail label="IP adresa">
                {d.ipAddress || d.publicIp ? (
                  <span className="font-mono text-sm">
                    {d.ipAddress ?? '—'}
                    {d.publicIp && <span className="text-fg-3"> · javna {d.publicIp}</span>}
                  </span>
                ) : null}
              </Detail>
              <Detail label="MAC">{d.macAddress ? <span className="font-mono text-sm">{d.macAddress}</span> : null}</Detail>
              <Detail label="Wi-Fi">{d.wifiSsid ? `${d.wifiSsid}${d.wifiSignal !== null ? ` · ${d.wifiSignal} dBm` : ''}` : null}</Detail>
              <Detail label="Baterija">
                {d.batteryLevel !== null ? (
                  <>
                    <Battery level={d.batteryLevel} charging={d.charging} />
                    {d.charging && <span className="ml-1 text-xs text-fg-3">puni se</span>}
                  </>
                ) : null}
              </Detail>
              <Detail label="Pohrana">
                {d.storageTotalMb ? `${mb(d.storageFreeMb)} slobodno od ${mb(d.storageTotalMb)}${storageUsedPct !== null ? ` (${storageUsedPct} % zauzeto)` : ''}` : null}
              </Detail>
              <Detail label="RAM">{d.ramTotalMb ? mb(d.ramTotalMb) : null}</Detail>
              <Detail label="Vrijeme rada">{d.uptimeSec !== null ? uptime(d.uptimeSec) : null}</Detail>
              <Detail label="Upisan">{d.enrolledAt ? dateTime(d.enrolledAt) : null}</Detail>
              <Detail label="Prvo javljanje">{dateTime(d.createdAt)}</Detail>
              <Detail label="Konfiguracija">
                {d.status === 'ENROLLED' ? (
                  <span className={d.appliedConfigVersion < d.configVersion ? 'text-warn' : 'text-ok'}>
                    primijenjena v{d.appliedConfigVersion}
                    {d.appliedConfigVersion < d.configVersion ? ` → čeka v${d.configVersion}` : ' (aktualna)'}
                  </span>
                ) : null}
              </Detail>
            </dl>
          </Card>
          {extraRows.length > 0 && (
            <Card title="Dodatni podaci s uređaja">
              <dl>
                {extraRows.map(([k, v]) => (
                  <Detail key={k} label={extraLabel(k)}>
                    <span className="break-all text-sm">{extraValue(k, v)}</span>
                  </Detail>
                ))}
              </dl>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card
            title="Dodjela"
            actions={
              canEdit && (
                <>
                  <MoveDevicesButton ids={[d.id]} orgs={orgs.map((o) => ({ id: o.id, label: o.label }))} sites={sites} current={{ orgId: d.orgId, siteId: d.siteId }} size="sm" />
                  <AssignProfileButton
                    ids={[d.id]}
                    profiles={profiles.map((p) => ({ id: p.id, name: p.name, platform: p.platform as Platform }))}
                    platforms={[d.platform as Platform]}
                    current={d.profileId}
                    size="sm"
                  />
                </>
              )
            }
          >
            <dl>
              <Detail label="Organizacija">{d.org ? orgPath(d.org) : null}</Detail>
              <Detail label="Lokacija">{d.site?.name}</Detail>
              <Detail label="Konfiguracija (profil)">{profileName}</Detail>
              <Detail label="Servisni PIN">
                <DevicePin id={d.id} pin={canEdit ? d.maintenancePin : d.maintenancePin ? '••••' : null} canEdit={canEdit} />
              </Detail>
            </dl>
          </Card>
          <Card title="Bilješke">
            <DeviceNotes id={d.id} notes={d.notes} canEdit={canOps} />
          </Card>
          {scope.owner && <DeviceErpCard deviceId={d.id} serial={d.serial} itemId={d.itemId} matches={matches} canEdit={canEdit} />}
        </div>
      </div>
    </>
  );
}
