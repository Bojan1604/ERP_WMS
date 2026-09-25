import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { env } from '@/server/env';
import { getPartner } from '@/server/queries/partners';
import { listPartnerPortalUsers } from '@/server/portal/users';
import { can } from '@/domain/permissions';
import { plain } from '@/server/plain';
import { PageHeader } from '@/components/ui/misc';
import { PortalUsers } from '@/components/portal/portal-users';

export const metadata = { title: 'Portal za klijente' };

/** Javna adresa portala: APP_URL ili adresa s koje je djelatnik otvorio stranicu. */
async function portalUrl() {
  const base = env().APP_URL;
  if (base) return `${base.replace(/\/$/, '')}/portal`;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}/portal`;
}

/** Pristupi portalu za klijente jednog partnera (dodaj, uključi/isključi, nova lozinka, obriši). */
export default async function PartnerPortalPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('partners');
  const { id } = await params;
  const partner = await getPartner(user.companyId, id);
  if (!partner) notFound();
  const [users, devices, reports, url] = await Promise.all([
    listPartnerPortalUsers(db, user.companyId, id),
    db.item.count({ where: { companyId: user.companyId, partnerId: id, state: { notIn: ['IN_STOCK', 'WRITTEN_OFF'] } } }),
    db.serviceOrder.count({ where: { companyId: user.companyId, partnerId: id, source: 'PORTAL' } }),
    portalUrl(),
  ]);
  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href={`/partneri/${id}`} className="hover:underline">
            ← {partner.name}
          </Link>
        }
        title="Portal za klijente"
        subtitle={`${partner.name} · ${devices} uređaja vidljivo na portalu · ${reports} prijava s portala`}
      />
      <PortalUsers partnerId={id} users={plain(users)} url={url} canEdit={can(user.perms, 'partners', 'edit')} />
    </>
  );
}
