'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { authenticatePortalUser, clearPortalSession, createPortalSession, requestMeta, setPortalCookie } from '@/server/portal/auth';
import { portalLoginByEmail, portalLoginByIp } from '@/server/portal/limits';

const schema = z.object({ email: z.string().trim().toLowerCase().min(1).max(200), password: z.string().min(1).max(200) });

/** Prijava klijenta na portal (vlastiti kolačić, ograničenje pokušaja po adresi i IP-u). */
export async function portalLogin(_: unknown, fd: FormData): Promise<{ error?: string }> {
  const parsed = schema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: 'Upišite e-adresu i lozinku.' };
  const { email, password } = parsed.data;
  const meta = await requestMeta();
  const ipKey = `ip:${meta.ip ?? '?'}`;
  if (portalLoginByEmail.blocked(email) || portalLoginByIp.blocked(ipKey)) return { error: 'Previše neuspjelih pokušaja. Pokušajte ponovno za minutu.' };

  const user = await authenticatePortalUser(email, password);
  if (!user) {
    portalLoginByEmail.fail(email);
    portalLoginByIp.fail(ipKey);
    return { error: 'Pogrešna e-adresa ili lozinka.' };
  }
  portalLoginByEmail.reset(email);
  const { token, expiresAt } = await createPortalSession(user.id, meta);
  await setPortalCookie(token, expiresAt);
  redirect('/portal');
}

export async function portalLogout() {
  await clearPortalSession();
  redirect('/portal/prijava');
}
