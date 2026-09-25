import Link from 'next/link';
import { Plus } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { ROLE_LABEL } from '@/domain/permissions';
import { Badge, PageHeader, TableWrap } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { dateTime } from '@/lib/format';
import { inCompany } from '@/server/services/users';
import { ONLINE_MS } from '@/server/queries/presence';

export const metadata = { title: 'Korisnici' };

export default async function UsersPage() {
  const user = await pageAccess('users');
  const now = new Date();
  const [users, sessions] = await Promise.all([
    db.user.findMany({
      // vanjski korisnici MDM-a (distributeri, klijenti) uređuju se u MDM → Organizacije
      where: { ...inCompany(user.companyId), role: { notIn: ['DISTRIBUTOR', 'CLIENT'] } },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, email: true, role: true, active: true, lastLoginAt: true, lastSeenAt: true, permissions: true, totpEnabled: true, canDanger: true, companyId: true },
    }),
    db.session.groupBy({ by: ['userId'], where: { user: inCompany(user.companyId), revokedAt: null, expiresAt: { gt: now } }, _count: { _all: true } }),
  ]);
  const active = new Map(sessions.map((s) => [s.userId, s._count._all]));
  return (
    <>
      <PageHeader
        title="Korisnici"
        subtitle="Prijava, uloge i prava po modulima"
        actions={
          <LinkButton href="/postavke/korisnici/novi" variant="primary" icon={<Plus className="size-4" />}>
            Novi korisnik
          </LinkButton>
        }
      />
      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th>Ime</th>
              <th>E-adresa</th>
              <th>Uloga</th>
              <th>Iznimke prava</th>
              <th>2FA</th>
              <th>Zadnja prijava</th>
              <th className="num">Aktivnih sesija</th>
              <th>Stanje</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const overrides = u.role === 'ADMIN' ? 0 : Object.keys((u.permissions as object) ?? {}).length;
              return (
                <tr key={u.id} className={u.active ? '' : 'opacity-60'}>
                  <td data-label="">
                    <Link prefetch={false} href={`/postavke/korisnici/${u.id}`} className="font-medium hover:underline">
                      {u.name}
                    </Link>
                    {u.id === user.id && <span className="ml-1.5 text-xs text-fg-3">(vi)</span>}
                    {u.lastSeenAt && now.getTime() - u.lastSeenAt.getTime() < ONLINE_MS && (active.get(u.id) ?? 0) > 0 && (
                      <span className="ml-1.5 inline-block size-2 rounded-full bg-ok align-middle" title={`Aktivan — ${dateTime(u.lastSeenAt)}`} />
                    )}
                    {u.companyId !== user.companyId && <span className="ml-1.5 text-xs text-fg-3">(trenutno u drugoj firmi)</span>}
                  </td>
                  <td data-label="E-adresa" className="text-fg-2">{u.email}</td>
                  <td data-label="Uloga">
                    <Badge tone={u.role === 'ADMIN' ? 'brand' : 'neutral'}>{ROLE_LABEL[u.role]}</Badge>
                  </td>
                  <td data-label="Iznimke prava">
                    {overrides ? <Badge tone="warn">{overrides}</Badge> : <span className="text-fg-4">—</span>}
                    {u.canDanger && u.role !== 'ADMIN' && <Badge tone="bad" className="ml-1">opasna zona</Badge>}
                  </td>
                  <td data-label="2FA">{u.totpEnabled ? <Badge tone="ok">da</Badge> : <span className="text-fg-4">—</span>}</td>
                  <td data-label="Zadnja prijava" className="text-fg-2">{u.lastLoginAt ? dateTime(u.lastLoginAt) : <span className="text-fg-4">nikad</span>}</td>
                  <td data-label="Aktivnih sesija" className="num">{active.get(u.id) ?? 0}</td>
                  <td data-label="Stanje">{u.active ? <Badge tone="ok">aktivan</Badge> : <Badge>neaktivan</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}
