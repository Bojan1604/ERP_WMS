import { LogOut } from 'lucide-react';
import { getPortalUser, portalPage } from '@/server/portal/auth';
import { db } from '@/server/db';
import { ToastProvider } from '@/components/ui/toast';
import { ResponsiveTables } from '@/components/layout/responsive-tables';
import { Tabs } from '@/components/ui/tabs';
import { portalLogout } from '../actions';
import type { Viewport } from 'next';
import { getCompanyColors } from '@/server/queries/lookups';
import { CompanyColorsStyle } from '@/components/layout/company-colors';
import { deriveTheme } from '@/domain/brand-colors';

/** Boja preglednika (theme-color) prati boju izbornika firme klijenta. */
export async function generateViewport(): Promise<Viewport> {
  const user = await getPortalUser();
  if (!user) return {};
  return { themeColor: deriveTheme(await getCompanyColors(user.companyId)).light.nav };
}

/** Okvir portala za prijavljenog klijenta: zaglavlje s firmom i partnerom, kartice, odjava. */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await portalPage();
  const [company, devices, orders] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { name: true, logo: true, email: true, phone: true, brandColor: true, menuColor: true } }),
    db.item.count({ where: { companyId: user.companyId, partnerId: user.partnerId, state: { notIn: ['IN_STOCK', 'WRITTEN_OFF'] } } }),
    db.serviceOrder.count({ where: { companyId: user.companyId, partnerId: user.partnerId } }),
  ]);
  return (
    <ToastProvider>
      <CompanyColorsStyle colors={company} />
      <div className="min-h-dvh bg-canvas">
        <header className="no-print sticky top-0 z-30 border-b border-line bg-panel">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-3 sm:px-5">
            {company.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={company.logo} alt="" className="max-h-9 max-w-24 object-contain" />
            ) : (
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand font-semibold text-white">{company.name.slice(0, 1)}</div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold leading-tight">Portal za klijente</p>
              <p className="truncate text-xs text-fg-3">
                {company.name} · {user.partnerName}
              </p>
            </div>
            <span className="hidden max-w-48 truncate text-sm text-fg-3 sm:block">{user.name || user.email}</span>
            <form action={portalLogout}>
              <button type="submit" className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm text-fg-2 hover:bg-muted" title="Odjava">
                <LogOut className="size-4" />
                <span className="max-sm:sr-only">Odjava</span>
              </button>
            </form>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-3 pb-16 pt-3 sm:px-5 sm:pt-5">
          <Tabs
            tabs={[
              { href: '/portal', label: 'Moji uređaji', count: devices },
              { href: '/portal/prijave', label: 'Moje prijave', count: orders },
            ]}
          />
          {children}
          <p className="no-print mt-8 text-xs text-fg-4">
            {[company.name, company.email, company.phone].filter(Boolean).join(' · ')}
          </p>
        </main>
      </div>
      <ResponsiveTables />
    </ToastProvider>
  );
}
