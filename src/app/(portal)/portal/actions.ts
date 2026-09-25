'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { authenticatePortalUser, clearPortalSession, createPortalSession, requestMeta, setPortalCookie } from '@/server/portal/auth';
import { beginAttempt, loginKeys, succeedAttempt } from '@/server/services/login-attempts';

const schema = z.object({ email: z.string().trim().toLowerCase().min(1).max(200), password: z.string().min(1).max(200) });

/** Prijava klijenta na portal (vlastiti kolačić, ograničenje pokušaja po adresi i IP-u). */
export async function portalLogin(_: unknown, fd: FormData): Promise<{ error?: string }> {
  const parsed = schema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: 'Upišite e-adresu i lozinku.' };
  const { email, password } = parsed.data;
  const meta = await requestMeta();
  // pokušaj se upisuje u bazu prije provjere lozinke (po adresi i po IP-u)
  const attempt = await beginAttempt(loginKeys('portal', email, meta.ip));
  if (!attempt.allowed) return { error: attempt.message };

  const user = await authenticatePortalUser(email, password);
  if (!user) return { error: 'Pogrešna e-adresa ili lozinka.' };
  await succeedAttempt(attempt);
  const { token, expiresAt } = await createPortalSession(user.id, meta);
  await setPortalCookie(token, expiresAt);
  redirect('/portal');
}

export async function portalLogout() {
  await clearPortalSession();
  redirect('/portal/prijava');
}
