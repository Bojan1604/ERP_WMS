import type { Viewport } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/server/auth';
import { db } from '@/server/db';
import { ROLE_LABEL } from '@/domain/permissions';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { MobileNav } from '@/components/layout/mobile-nav';
import { ResponsiveTables } from '@/components/layout/responsive-tables';
import { ToastProvider } from '@/components/ui/toast';
import { portalNewCount } from '@/server/portal/count';
import { currentBuildId, onlineUsers } from '@/server/queries/presence';
import { getCompanyColors } from '@/server/queries/lookups';
import { CompanyColorsStyle } from '@/components/layout/company-colors';
import { deriveTheme } from '@/domain/brand-colors';

/** Boja preglednika (theme-color) prati boju izbornika firme. */
export async function generateViewport(): Promise<Viewport> {
  const user = await getUser();
  if (!user) return {};
  return { themeColor: deriveTheme(await getCompanyColors(user.companyId)).light.nav };
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect('/login');

  const c = user.companyId;
  // vanjski korisnici MDM-a ne vide ERP brojače
  const [approvals, reserved, returning, portalNew] = user.mdmOrgId
    ? [0, 0, 0, 0]
    : await Promise.all([
        db.approvalRequest.count({ where: { companyId: c, status: 'PENDING' } }),
        db.item.count({ where: { companyId: c, state: 'RESERVED' } }),
        db.item.count({ where: { companyId: c, state: 'RETURNING' } }),
        // nove prijave kvara s portala za klijente (crvena značka uz Servis)
        portalNewCount(c),
      ]);

  // zaglavlje: firme za prebacivanje (više firmi), tko je prijavljen, izdanje programa (obavijest o novoj verziji)
  const [access, online, buildId, colors] = await Promise.all([
    user.mdmOrgId ? [] : db.userCompany.findMany({ where: { userId: user.id }, select: { company: { select: { id: true, name: true } } } }),
    user.mdmOrgId ? [] : onlineUsers(c),
    currentBuildId(),
    getCompanyColors(c),
  ]);
  const companies = [{ id: c, name: user.companyName }, ...access.map((a) => a.company).filter((x) => x.id !== c)].sort((a, b) => a.name.localeCompare(b.name, 'hr'));

  return (
    <ToastProvider>
      <CompanyColorsStyle colors={colors} />
      <div className="flex h-dvh overflow-hidden">
        <Sidebar
          perms={user.perms}
          isAdmin={user.role === 'ADMIN'}
          canDanger={!!user.canDanger}
          company={user.mdmOrgName ?? user.companyName}
          badges={{ '/skladiste/odobrenja': approvals, '/skladiste/izlaz': reserved + returning, '/servis': portalNew }}
          alerts={['/servis']}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar user={{ id: user.id, name: user.name, role: ROLE_LABEL[user.role] }} companies={companies} companyId={c} online={online} buildId={buildId} />
          <main className="min-h-0 flex-1 overflow-y-auto scroll-slim p-3 pb-24 sm:p-5 lg:pb-5">{children}</main>
        </div>
      </div>
      <MobileNav perms={user.perms} />
      <ResponsiveTables />
    </ToastProvider>
  );
}
