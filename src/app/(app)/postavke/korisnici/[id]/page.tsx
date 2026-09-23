import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import type { Level } from '@/domain/permissions';
import { PageHeader } from '@/components/ui/misc';
import { ActionButton } from '@/components/ui/action';
import { UserForm } from '@/components/settings/user-form';
import { dateTime } from '@/lib/format';
import { revokeSessionsAction, saveUserAction } from '../actions';

export const metadata = { title: 'Korisnik' };

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await pageAccess('users');
  const { id } = await params;
  const isNew = id === 'novi';
  const u = isNew
    ? null
    : await db.user.findFirst({
        where: { id, companyId: me.companyId },
        select: { id: true, name: true, email: true, role: true, active: true, permissions: true, lastLoginAt: true, createdAt: true },
      });
  if (!isNew && !u) notFound();
  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/postavke/korisnici" className="hover:underline">
            ← Korisnici
          </Link>
        }
        title={u ? u.name : 'Novi korisnik'}
        subtitle={u ? `Otvoren ${dateTime(u.createdAt)} · zadnja prijava ${u.lastLoginAt ? dateTime(u.lastLoginAt) : 'nikad'}` : undefined}
        actions={
          u && u.id !== me.id ? (
            <ActionButton
              action={revokeSessionsAction}
              input={{ id: u.id }}
              icon={<LogOut className="size-4" />}
              confirm={`Odjaviti korisnika ${u.name} sa svih uređaja? Morat će se ponovno prijaviti.`}
              confirmLabel="Odjavi"
            >
              Odjavi sa svih uređaja
            </ActionButton>
          ) : null
        }
      />
      <UserForm
        isSelf={u?.id === me.id}
        save={saveUserAction}
        value={
          u
            ? { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, permissions: (u.permissions ?? {}) as Record<string, Level> }
            : { name: '', email: '', role: 'SALES', active: true, permissions: {} }
        }
      />
    </>
  );
}
