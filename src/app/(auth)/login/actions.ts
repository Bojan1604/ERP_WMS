'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/server/db';
import { createSession, destroySession, verifyPassword } from '@/server/auth';

const schema = z.object({ email: z.string().trim().toLowerCase().min(1), password: z.string().min(1), next: z.string().optional() });

// Jednostavno ograničenje pokušaja po adresi (u memoriji procesa).
const attempts = new Map<string, { n: number; until: number }>();

export async function login(_: unknown, fd: FormData): Promise<{ error?: string }> {
  const parsed = schema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: 'Upišite e-poštu i lozinku.' };
  const { email, password, next } = parsed.data;

  const a = attempts.get(email);
  if (a && a.n >= 5 && a.until > Date.now()) return { error: 'Previše neuspjelih pokušaja. Pokušajte ponovno za minutu.' };

  const user = await db.user.findUnique({ where: { email } });
  if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
    attempts.set(email, { n: (a?.n ?? 0) + 1, until: Date.now() + 60_000 });
    return { error: 'Pogrešna e-pošta ili lozinka.' };
  }
  attempts.delete(email);
  await createSession(user.id);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  redirect(safeNext(next));
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
