import { redirect } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { accessibleCompanies } from '@/server/services/companies';
import { PageHeader } from '@/components/ui/misc';
import { CompaniesManager } from '@/components/settings/companies';

export const metadata = { title: 'Firme' };

/** Više firmi (F13): popis firmi, nova firma, pristup korisnika po firmama, brisanje prazne firme. Samo administrator. */
export default async function CompaniesPage() {
  const user = await pageAccess('settings');
  if (user.role !== 'ADMIN') redirect('/zabranjeno?modul=settings');
  const companies = await accessibleCompanies(db, user.id);
  const ids = companies.map((c) => c.id);
  const [items, invoices, partners, users] = await Promise.all([
    db.item.groupBy({ by: ['companyId'], where: { companyId: { in: ids } }, _count: { _all: true } }),
    db.invoice.groupBy({ by: ['companyId'], where: { companyId: { in: ids } }, _count: { _all: true } }),
    db.partner.groupBy({ by: ['companyId'], where: { companyId: { in: ids } }, _count: { _all: true } }),
    db.user.findMany({
      where: { role: { notIn: ['DISTRIBUTOR', 'CLIENT'] }, OR: [{ companyId: { in: ids } }, { companies: { some: { companyId: { in: ids } } } }] },
      orderBy: { name: 'asc' },
      take: 500,
      select: { id: true, name: true, email: true, role: true, active: true, companyId: true, companies: { where: { companyId: { in: ids } }, select: { companyId: true } } },
    }),
  ]);
  const count = (rows: Array<{ companyId: string; _count: { _all: number } }>, id: string) => rows.find((r) => r.companyId === id)?._count._all ?? 0;
  return (
    <>
      <PageHeader title="Firme" subtitle="Svaka firma ima potpuno odvojene podatke — uređaje, račune, ugovore, partnere i troškove. Prebacivanje je u zaglavlju." />
      <CompaniesManager
        currentId={user.companyId}
        companies={companies.map((c) => ({ ...c, items: count(items, c.id), invoices: count(invoices, c.id), partners: count(partners, c.id) }))}
        users={users.map((u) => ({
          id: u.id, name: u.name, email: u.email, active: u.active, isAdmin: u.role === 'ADMIN', currentId: u.companyId,
          access: [...new Set([u.companyId, ...u.companies.map((x) => x.companyId)])],
        }))}
        meId={user.id}
      />
    </>
  );
}
