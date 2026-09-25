'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db, transaction } from '@/server/db';
import { createSession, destroySession, verifyPassword } from '@/server/auth';
import { audit } from '@/server/audit';
import { CHALLENGE_TTL_MS, checkSecondFactor, readChallenge, signChallenge } from '@/server/services/two-factor';

const schema = z.object({ email: z.string().trim().toLowerCase().min(1), password: z.string().min(1), next: z.string().optional() });
const codeSchema = z.object({ code: z.string().trim().min(6).max(20), next: z.string().optional() });

/** Kolačić prvog koraka (lozinka ispravna, čeka se kod iz aplikacije). */
const CHALLENGE_COOKIE = 'wms_2fa';

export type LoginState = { error?: string; step?: 'totp'; email?: string };

// Jednostavno ograničenje pokušaja po adresi (u memoriji procesa) — vrijedi za lozinku i za kod.
const attempts = new Map<string, { n: number; until: number }>();
const MAX_ATTEMPTS = 5;

function limited(key: string) {
  const a = attempts.get(key);
  return !!a && a.n >= MAX_ATTEMPTS && a.until > Date.now();
}
function fail(key: string) {
  const a = attempts.get(key);
  const fresh = !a || a.until <= Date.now();
  attempts.set(key, { n: (fresh ? 0 : a.n) + 1, until: Date.now() + 60_000 });
}

export async function login(_: LoginState, fd: FormData): Promise<LoginState> {
  const parsed = schema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: 'Upišite e-poštu i lozinku.' };
  const { email, password, next } = parsed.data;

  if (limited(email)) return { error: 'Previše neuspjelih pokušaja. Pokušajte ponovno za minutu.' };

  const user = await db.user.findUnique({ where: { email } });
  if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
    fail(email);
    return { error: 'Pogrešna e-pošta ili lozinka.' };
  }
  attempts.delete(email);

  // prijava u dva koraka: sesija nastaje tek nakon ispravnog koda
  if (user.totpEnabled && user.totpSecret) {
    (await cookies()).set(CHALLENGE_COOKIE, signChallenge(user.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
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
  const key = `2fa:${userId}`;
  if (limited(key)) return { step: 'totp', error: 'Previše neuspjelih pokušaja. Pokušajte ponovno za minutu.' };

  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, companyId: true, active: true } });
  if (!user?.active) return { error: 'Prijava nije moguća.' };
  const kind = await transaction(async (tx) => {
    const k = await checkSecondFactor(tx, userId, parsed.data.code);
    if (k === 'backup') {
      await audit(tx, user, { entity: 'user', entityId: user.id, action: '2fa-backup', summary: 'Prijava rezervnim kodom (kod je iskorišten)' });
    }
    return k;
  });
  if (!kind) {
    fail(key);
    return { step: 'totp', error: 'Kod nije ispravan.' };
  }
  attempts.delete(key);
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
