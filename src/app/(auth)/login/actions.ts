'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db, transaction } from '@/server/db';
import { createSession, destroySession, verifyPassword } from '@/server/auth';
import { audit } from '@/server/audit';
import { CHALLENGE_TTL_MS, checkSecondFactor, readChallenge, signChallenge } from '@/server/services/two-factor';
import { beginAttempt, dummyPasswordCheck, loginKeys, requestIp, succeedAttempt } from '@/server/services/login-attempts';
import { secureCookie } from '@/server/cookie-secure';

const schema = z.object({ email: z.string().trim().toLowerCase().min(1).max(200), password: z.string().min(1).max(200), next: z.string().optional() });
const codeSchema = z.object({ code: z.string().trim().min(6).max(20), next: z.string().optional() });

/** Kolačić prvog koraka (lozinka ispravna, čeka se kod iz aplikacije). */
const CHALLENGE_COOKIE = 'wms_2fa';

export type LoginState = { error?: string; step?: 'totp'; email?: string };

export async function login(_: LoginState, fd: FormData): Promise<LoginState> {
  const parsed = schema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: 'Upišite e-poštu i lozinku.' };
  const { email, password, next } = parsed.data;

  // pokušaj se upisuje prije provjere (po adresi i po IP-u) — istodobni zahtjevi ne zaobilaze granicu
  const attempt = await beginAttempt(loginKeys('staff', email, await requestIp()));
  if (!attempt.allowed) return { error: attempt.message };

  const user = await db.user.findUnique({ where: { email } });
  // nepostojeća adresa: ista provjera lozinke (isto trajanje), da se ne odaje koje adrese postoje
  const ok = user ? await verifyPassword(password, user.passwordHash) : await dummyPasswordCheck(password);
  if (!user || !ok || !user.active) return { error: 'Pogrešna e-pošta ili lozinka.' };
  await succeedAttempt(attempt);

  // prijava u dva koraka: sesija nastaje tek nakon ispravnog koda
  if (user.totpEnabled && user.totpSecret) {
    (await cookies()).set(CHALLENGE_COOKIE, signChallenge(user.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: await secureCookie(),
      path: '/login',
      maxAge: CHALLENGE_TTL_MS / 1000,
    });
    return { step: 'totp', email };
  }
  await createSession(user.id);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  redirect(safeNext(next));
}

/** Drugi korak: kod iz aplikacije (6 znamenki) ili rezervni kod. */
export async function verifyLoginCode(_: LoginState, fd: FormData): Promise<LoginState> {
  const store = await cookies();
  const userId = readChallenge(store.get(CHALLENGE_COOKIE)?.value);
  if (!userId) return { error: 'Prijava je istekla — upišite ponovno e-poštu i lozinku.' };
  const parsed = codeSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { step: 'totp', error: 'Upišite šesteroznamenkasti kod ili rezervni kod.' };
  const attempt = await beginAttempt(loginKeys('2fa', userId, await requestIp()));
  if (!attempt.allowed) return { step: 'totp', error: attempt.message };

  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, companyId: true, active: true } });
  if (!user?.active) return { error: 'Prijava nije moguća.' };
  const kind = await transaction(async (tx) => {
    const k = await checkSecondFactor(tx, userId, parsed.data.code);
    if (k === 'backup') {
      await audit(tx, user, { entity: 'user', entityId: user.id, action: '2fa-backup', summary: 'Prijava rezervnim kodom (kod je iskorišten)' });
    }
    return k;
  });
  if (!kind) return { step: 'totp', error: 'Kod nije ispravan.' };
  await succeedAttempt(attempt);
  store.delete({ name: CHALLENGE_COOKIE, path: '/login' });
  await createSession(user.id);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  redirect(safeNext(parsed.data.next));
}

/** Samo relativna putanja iste domene — sprječava preusmjeravanje na tuđu stranicu (`//evil`, `/\\evil`). */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  try {
    const u = new URL(next, 'http://x');
    if (u.origin !== 'http://x') return '/';
    return u.pathname + u.search + u.hash;
  } catch {
    return '/';
  }
}

export async function logout() {
  await destroySession();
  redirect('/login');
}
