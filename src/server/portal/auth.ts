import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthError } from '../errors';
import { revokePortalSession, resolvePortalSession, type PortalUser } from './session';
import { PORTAL_COOKIE, PORTAL_PATH } from '@/lib/portal-cookie';

export * from './session';

// ---------------------------------------------------------------- kolačić (samo u zahtjevu)

export async function requestMeta() {
  const h = await headers();
  return { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null, userAgent: h.get('user-agent') };
}

export async function setPortalCookie(token: string, expiresAt: Date) {
  (await cookies()).set(PORTAL_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: PORTAL_PATH,
    expires: expiresAt,
  });
}

export async function clearPortalSession() {
  const store = await cookies();
  await revokePortalSession(store.get(PORTAL_COOKIE)?.value);
  store.set(PORTAL_COOKIE, '', { path: PORTAL_PATH, expires: new Date(0) });
}

/** Prijavljeni klijent; rezultat se pamti za trajanje jednog zahtjeva. */
export const getPortalUser = cache(async (): Promise<PortalUser | null> => resolvePortalSession((await cookies()).get(PORTAL_COOKIE)?.value));

/** Za API rute i akcije portala. */
export async function requirePortalUser(): Promise<PortalUser> {
  const u = await getPortalUser();
  if (!u) throw new AuthError('Niste prijavljeni.');
  return u;
}

/** Za stranice portala: neprijavljenog šalje na prijavu portala. */
export async function portalPage(): Promise<PortalUser> {
  const u = await getPortalUser();
  if (!u) redirect('/portal/prijava');
  return u;
}
