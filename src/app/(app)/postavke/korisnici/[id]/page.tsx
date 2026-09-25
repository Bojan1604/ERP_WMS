import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LogOut, ShieldOff } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import type { Level } from '@/domain/permissions';
import { Badge, Notice, PageHeader } from '@/components/ui/misc';
import { assertCanManage, inCompany } from '@/server/services/users';
import { ActionButton } from '@/components/ui/action';
import { UserForm } from '@/components/settings/user-form';
import { dateTime } from '@/lib/format';
import { resetTotpAction, revokeSessionsAction, saveUserAction } from '../actions';

export const metadata = { title: 'Korisnik' };

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await pageAccess('users');
  const { id } = await params;
  const isNew = id === 'novi';
  const u = isNew
    ? null
    : await db.user.findFirst({
        where: { id, ...inCompany(me.companyId), role: { notIn: ['DISTRIBUTOR', 'CLIENT'] } },
        select: {
          id: true, name: true, email: true, role: true, active: true, oib: true, permissions: true, lastLoginAt: true, createdAt: true,
          canDanger: true, requireApproval: true, totpEnabled: true,
        },
      });
  const company = await db.company.findUniqueOrThrow({ where: { id: me.companyId }, select: { statusChangeNeedsApproval: true } });
  if (!isNew && !u) notFound();
  // ne-administrator ne upravlja korisnikom s višim pravima (lozinka, e-adresa, odjava…) — samo pregled
  let locked: string | null = null;
  if (u && u.id !== me.id && me.role !== 'ADMIN') {
    try {
      assertCanManage({ role: me.role, permissions: me.perms }, u);
    } catch (e) {
      locked = e instanceof Error ? e.message : 'Korisnika uređuje administrator.';
    }
  }
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
          u && u.id !== me.id && !locked ? (
            <>
            {u.totpEnabled && <Badge tone="ok">2FA uključena</Badge>}
            {u.totpEnabled && me.role === 'ADMIN' && (
              <ActionButton
                action={resetTotpAction}
                input={{ id: u.id }}
                icon={<ShieldOff className="size-4" />}
                confirm={`Poništiti prijavu u dva koraka za ${u.name}? Korisnik će se prijavljivati samo lozinkom (i odjavljuje se sa svih uređaja) dok je ponovno ne uključi.`}
                confirmLabel="Poništi 2FA"
              >
                Poništi 2FA
              </ActionButton>
            )}
            <ActionButton
              action={revokeSessionsAction}
              input={{ id: u.id }}
              icon={<LogOut className="size-4" />}
              confirm={`Odjaviti korisnika ${u.name} sa svih uređaja? Morat će se ponovno prijaviti.`}
              confirmLabel="Odjavi"
            >
              Odjavi sa svih uređaja
            </ActionButton>
            </>
          ) : null
        }
      />
      {locked ? (
        <Notice>
          {locked} ({u?.email})
        </Notice>
      ) : (
      <UserForm
        isSelf={u?.id === me.id}
        actorIsAdmin={me.role === 'ADMIN'}
        companyApproval={company.statusChangeNeedsApproval}
        save={saveUserAction}
        value={
          u
            ? {
                id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, oib: u.oib ?? '', permissions: (u.permissions ?? {}) as Record<string, Level>,
                canDanger: u.canDanger, requireApproval: u.requireApproval,
              }
            : { name: '', email: '', role: 'SALES', active: true, oib: '', permissions: {}, canDanger: false, requireApproval: null }
        }
      />
      )}
    </>
  );
}
