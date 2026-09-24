import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Trash2, UserX, UserCheck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { getOrg, orgOptions, profileOptions } from '@/server/queries/mdm';
import { getPartnerOptions } from '@/server/queries/lookups';
import { can, LEVEL_LABEL, ROLE_DEFAULTS, ROLE_LABEL, type Level } from '@/domain/permissions';
import { Badge, Card, Detail, PageHeader } from '@/components/ui/misc';
import { ActionButton } from '@/components/ui/action';
import { LinkButton } from '@/components/ui/button';
import { OrgDialog, ResetPasswordDialog, SiteDialog, UserDialog } from '@/components/mdm/org-forms';
import { emptyOrg, ORG_TYPE_LABEL } from '@/components/mdm/common';
import { dateTime, integer } from '@/lib/format';
import { deleteOrgAction, deleteSiteAction, setMdmUserActiveAction } from '../actions';

export const metadata = { title: 'MDM organizacija' };

export default async function OrgPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('mdm', 'view');
  const scope = await getMdmScope(user);
  const { id } = await params;
  const org = await getOrg(scope, id);
  if (!org) notFound();
  const canEdit = can(user.perms, 'mdm', 'edit');
  const all = await orgOptions(scope);
  const home = scope.homeOrgId ? all.find((o) => o.id === scope.homeOrgId) : null;
  const manageUsers = canEdit && (scope.owner || home?.type === 'DISTRIBUTOR');
  const [profiles, partners] = await Promise.all([
    canEdit ? profileOptions(scope) : [],
    scope.owner && canEdit ? getPartnerOptions(user.companyId, 'any') : [],
  ]);
  const role = org.type === 'DISTRIBUTOR' ? 'DISTRIBUTOR' : 'CLIENT';
  const defaultLevel = ROLE_DEFAULTS[role].mdm;
  const maxLevel = (scope.level === 'none' ? 'view' : scope.level) as 'view' | 'ops' | 'edit';
  const isHome = org.id === scope.homeOrgId;
  const parentVisible = org.parent && (!scope.orgIds || scope.orgIds.includes(org.parent.id));

  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/mdm/organizacije" className="hover:underline">
            ← Organizacije
          </Link>
        }
        title={org.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={org.type === 'DISTRIBUTOR' ? 'brand' : 'neutral'}>{ORG_TYPE_LABEL[org.type]}</Badge>
            {!org.active && <Badge tone="warn">neaktivna</Badge>}
            {org.parent &&
              (parentVisible ? (
                <Link prefetch={false} href={`/mdm/organizacije/${org.parent.id}`} className="hover:underline">
                  distributer: {org.parent.name}
                </Link>
              ) : (
                <span>distributer: {org.parent.name}</span>
              ))}
          </span>
        }
        actions={
          <>
            <LinkButton href={`/mdm/uredaji?org=${org.id}`}>Uređaji ({integer(org._count.devices)})</LinkButton>
            {canEdit && (
              <OrgDialog
                label="Uredi"
                owner={scope.owner}
                lockActive={isHome}
                partners={partners.map((p) => ({ value: p.id, label: p.city ? `${p.name} (${p.city})` : p.name }))}
                value={{
                  id: org.id,
                  type: org.type,
                  parentId: org.parentId,
                  name: org.name,
                  oib: org.oib ?? '',
                  email: org.email ?? '',
                  phone: org.phone ?? '',
                  address: org.address ?? '',
                  city: org.city ?? '',
                  note: org.note ?? '',
                  active: org.active,
                  partnerId: org.partnerId,
                }}
              />
            )}
            {canEdit && !isHome && (
              <ActionButton action={deleteOrgAction} input={{ id: org.id }} variant="danger" icon={<Trash2 className="size-4" />} confirm={`Obrisati organizaciju „${org.name}"? Brisanje nije moguće dok ima uređaje, klijente ili korisnike.`} confirmLabel="Obriši">
                Obriši
              </ActionButton>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-4">
          <Card title="Podaci">
            <dl>
              <Detail label="OIB">{org.oib}</Detail>
              <Detail label="E-adresa">{org.email}</Detail>
              <Detail label="Telefon">{org.phone}</Detail>
              <Detail label="Adresa">{[org.address, org.city].filter(Boolean).join(', ') || null}</Detail>
              {scope.owner && (
                <Detail label="ERP partner">
                  {org.partner ? (
                    <Link prefetch={false} href={`/partneri/${org.partner.id}`} className="link">
                      {org.partner.name}
                    </Link>
                  ) : null}
                </Detail>
              )}
              <Detail label="Napomena">{org.note}</Detail>
              <Detail label="Otvorena">{dateTime(org.createdAt)}</Detail>
            </dl>
          </Card>
          {org.type === 'DISTRIBUTOR' && (
            <Card
              title={`Klijenti (${org.children.length})`}
              padded={false}
              actions={canEdit && (scope.owner || isHome) && <OrgDialog label="Novi klijent" size="sm" owner={scope.owner} value={emptyOrg('CUSTOMER', org.id)} distributors={[{ id: org.id, name: org.name }]} />}
            >
              {org.children.length ? (
                <ul className="divide-y divide-line">
                  {org.children.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2">
                      <Link prefetch={false} href={`/mdm/organizacije/${c.id}`} className="link">
                        {c.name}
                      </Link>
                      <span className="text-sm text-fg-3">
                        {!c.active && <Badge tone="warn">neaktivan</Badge>} {integer(c._count.devices)} uređaja
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-4 text-sm text-fg-3">Distributer još nema klijenata.</p>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card
            title={`Lokacije (${org.sites.length})`}
            padded={false}
            actions={canEdit && <SiteDialog label="Nova lokacija" profiles={profiles} value={{ orgId: org.id, name: '', address: '', timezone: 'Europe/Zagreb', profileId: null, note: '' }} />}
          >
            {org.sites.length ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Lokacija</th>
                    <th>Adresa</th>
                    <th>Konfiguracija</th>
                    <th className="num">Uređaja</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {org.sites.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link prefetch={false} href={`/mdm/uredaji?site=${s.id}`} className="link font-medium">
                          {s.name}
                        </Link>
                        {s.timezone !== 'Europe/Zagreb' && <div className="text-xs text-fg-3">{s.timezone}</div>}
                      </td>
                      <td className="text-fg-2">{s.address ?? '—'}</td>
                      <td>{s.profile?.name ?? <span className="text-fg-4">—</span>}</td>
                      <td className="num">{integer(s._count.devices)}</td>
                      <td className="whitespace-nowrap text-right">
                        {canEdit && (
                          <>
                            <SiteDialog label="Uredi" profiles={profiles} value={{ id: s.id, orgId: org.id, name: s.name, address: s.address ?? '', timezone: s.timezone, profileId: s.profileId, note: s.note ?? '' }} />
                            {s._count.devices === 0 && (
                              <ActionButton action={deleteSiteAction} input={{ id: s.id }} size="sm" variant="ghost" icon={<Trash2 className="size-4" />} confirm={`Obrisati lokaciju „${s.name}"?`} confirmLabel="Obriši">
                                Obriši
                              </ActionButton>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-4 py-4 text-sm text-fg-3">Nema lokacija. Lokacija (npr. restoran, trgovina) nosi zadanu konfiguraciju za svoje uređaje.</p>
            )}
          </Card>

          <Card
            title={`Korisnici (${org.users.length})`}
            padded={false}
            actions={manageUsers && <UserDialog label="Novi korisnik" roleLabel={ROLE_LABEL[role]} defaultLevel={LEVEL_LABEL[defaultLevel]} maxLevel={maxLevel} value={{ orgId: org.id, name: '', email: '', active: true, level: '' }} />}
          >
            {org.users.length ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Ime</th>
                    <th>E-adresa</th>
                    <th>Prava</th>
                    <th>Zadnja prijava</th>
                    <th>Stanje</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {org.users.map((u) => {
                    const lvl = ((u.permissions ?? {}) as Record<string, Level>).mdm ?? null;
                    const self = u.id === user.id;
                    return (
                      <tr key={u.id} className={u.active ? '' : 'opacity-60'}>
                        <td className="font-medium">
                          {u.name}
                          {self && <span className="ml-1.5 text-xs text-fg-3">(vi)</span>}
                        </td>
                        <td className="text-fg-2">{u.email}</td>
                        <td>{lvl ? <Badge tone="warn">{LEVEL_LABEL[lvl]}</Badge> : <span className="text-fg-3">{LEVEL_LABEL[ROLE_DEFAULTS[u.role].mdm]}</span>}</td>
                        <td className="text-fg-2">{u.lastLoginAt ? dateTime(u.lastLoginAt) : <span className="text-fg-4">nikad</span>}</td>
                        <td>{u.active ? <Badge tone="ok">aktivan</Badge> : <Badge>neaktivan</Badge>}</td>
                        <td className="whitespace-nowrap text-right">
                          {manageUsers && (
                            <>
                              <UserDialog
                                label="Uredi"
                                roleLabel={ROLE_LABEL[u.role]}
                                defaultLevel={LEVEL_LABEL[ROLE_DEFAULTS[u.role].mdm]}
                                maxLevel={maxLevel}
                                value={{ id: u.id, orgId: org.id, name: u.name, email: u.email, active: u.active, level: (lvl ?? '') as '' | 'view' | 'ops' | 'edit' }}
                              />
                              <ResetPasswordDialog id={u.id} name={u.name} />
                              {!self && (
                                <ActionButton
                                  action={setMdmUserActiveAction}
                                  input={{ id: u.id, active: !u.active }}
                                  size="sm"
                                  variant="ghost"
                                  icon={u.active ? <UserX className="size-4" /> : <UserCheck className="size-4" />}
                                  confirm={u.active ? `Deaktivirati korisnika ${u.name}? Odjavljuje se odmah sa svih uređaja.` : undefined}
                                  confirmLabel="Deaktiviraj"
                                >
                                  {u.active ? 'Deaktiviraj' : 'Aktiviraj'}
                                </ActionButton>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="px-4 py-4 text-sm text-fg-3">Organizacija nema korisnika portala.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
