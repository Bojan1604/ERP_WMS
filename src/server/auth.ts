import 'server-only';
import { cache } from 'react';
import { createHash, randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { env } from './env';
import { AuthError } from './errors';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { can, resolvePermissions, type Level, type Module, type PermissionMap, type RoleCode } from '@/domain/permissions';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: RoleCode;
  companyId: string;
  companyName: string;
  perms: PermissionMap;
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain: string, h: string) => bcrypt.compare(plain, h);

/**
 * Sesija je nasumičan token u httpOnly kolačiću; u bazi se čuva samo njegov
 * sažetak, pa curenje baze ne otkriva aktivne sesije. Odjava i blokada
 * korisnika djeluju odmah.
 */
export async function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_HOURS * 3_600_000);
  const h = await headers();
  await db.session.create({
    data: {
      userId,
      tokenHash: hash(token),
      expiresAt,
      ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: h.get('user-agent')?.slice(0, 300) ?? null,
    },
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db.session.updateMany({ where: { tokenHash: hash(token), revokedAt: null }, data: { revokedAt: new Date() } });
  store.delete(SESSION_COOKIE);
}

/** Prijavljeni korisnik; rezultat se pamti za trajanje jednog zahtjeva. */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await db.session.findUnique({
    where: { tokenHash: hash(token) },
    include: { user: { include: { company: { select: { name: true } } } } },
  });
  if (!s || s.revokedAt || s.expiresAt < new Date() || !s.user.active) return null;
  const u = s.user;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    companyId: u.companyId,
    companyName: u.company.name,
    perms: resolvePermissions(u.role, u.permissions as Record<string, Level>),
  };
});

export async function requireUser(): Promise<SessionUser> {
  const u = await getUser();
  if (!u) throw new AuthError('Niste prijavljeni.');
  return u;
}

export async function requireAccess(module: Module, level: Exclude<Level, 'none'> = 'view'): Promise<SessionUser> {
  const u = await requireUser();
  if (!can(u.perms, module, level)) throw new AuthError('Nemate pravo na ovu radnju.', 403);
  return u;
}

/** Za stranice: neprijavljenog šalje na prijavu, bez prava na nadzornu ploču. */
export async function pageAccess(module: Module, level: Exclude<Level, 'none'> = 'view'): Promise<SessionUser> {
  const u = await getUser();
  if (!u) redirect('/login');
  if (!can(u.perms, module, level)) redirect(`/zabranjeno?modul=${module}`);
  return u;
}

/** Radnje nad cijelom firmom (uvoz, izvoz, vraćanje kopije) — samo administrator. */
export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser();
  if (u.role !== 'ADMIN') throw new AuthError('Ovu radnju smije samo administrator.', 403);
  return u;
}
