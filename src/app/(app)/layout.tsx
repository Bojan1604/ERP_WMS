import { redirect } from 'next/navigation';
import { getUser } from '@/server/auth';
import { db } from '@/server/db';
import { ROLE_LABEL } from '@/domain/permissions';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { ToastProvider } from '@/components/ui/toast';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect('/login');

  const c = user.companyId;
  const [approvals, reserved, returning] = await Promise.all([
    db.approvalRequest.count({ where: { companyId: c, status: 'PENDING' } }),
    db.item.count({ where: { companyId: c, state: 'RESERVED' } }),
    db.item.count({ where: { companyId: c, state: 'RETURNING' } }),
  ]);

  return (
    <ToastProvider>
      <div className="flex h-dvh overflow-hidden">
        <Sidebar
          perms={user.perms}
          company={user.companyName}
          badges={{ '/skladiste/odobrenja': approvals, '/skladiste/izlaz': reserved + returning }}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar user={{ name: user.name, role: ROLE_LABEL[user.role] }} />
          <main className="min-h-0 flex-1 overflow-y-auto scroll-slim p-4 sm:p-5">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
