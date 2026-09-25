import { redirect } from 'next/navigation';
import { getUser } from '@/server/auth';
import { db } from '@/server/db';
import { ROLE_LABEL } from '@/domain/permissions';
import { PageHeader } from '@/components/ui/misc';
import { MyAccount } from '@/components/settings/my-account';
import { dateTime } from '@/lib/format';

export const metadata = { title: 'Moj račun' };

/** Moj račun: ime, lozinka i prijava u dva koraka — za svakog prijavljenog korisnika. */
export default async function MyAccountPage() {
  const me = await getUser();
  if (!me) redirect('/login');
  const u = await db.user.findUniqueOrThrow({
    where: { id: me.id },
    select: { name: true, email: true, role: true, totpEnabled: true, backupCodes: true, lastLoginAt: true, createdAt: true },
  });
  return (
    <>
      <PageHeader title="Moj račun" subtitle={`${u.email} · ${ROLE_LABEL[u.role]} · zadnja prijava ${u.lastLoginAt ? dateTime(u.lastLoginAt) : '—'}`} />
      <MyAccount name={u.name} email={u.email} totpEnabled={u.totpEnabled} backupLeft={u.backupCodes.length} />
    </>
  );
}
