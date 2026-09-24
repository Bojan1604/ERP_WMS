'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { DomainError } from '@/server/errors';
import { zBool, zId, zOptId, zOptText, zReq } from '@/server/zod';
import { revokeUserSessions, saveUser } from '@/server/services/users';

const schema = z.object({
  id: zOptId,
  name: zReq('Ime'),
  email: zReq('E-adresa'),
  role: z.enum(['ADMIN', 'MANAGER', 'SALES', 'WAREHOUSE', 'ACCOUNTANT']),
  active: zBool,
  oib: zOptText.refine((v) => v === null || /^\d{11}$/.test(v), 'OIB mora imati 11 znamenki'),
  password: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().nullable()),
  permissions: z.record(z.string()).default({}),
});

/** Vanjske korisnike MDM-a (DISTRIBUTOR, CLIENT) ERP ne uređuje — to se radi u MDM → Organizacije. */
async function assertErpUser(companyId: string, id: string) {
  const u = await db.user.findFirst({ where: { id, companyId }, select: { role: true } });
  if (!u || u.role === 'DISTRIBUTOR' || u.role === 'CLIENT') throw new DomainError('Korisnik ne postoji.');
}

export const saveUserAction = action({ module: 'users', level: 'edit' }, schema, async ({ id, ...input }, user) => {
  if (id) await assertErpUser(user.companyId, id);
  const uid = await transaction((tx) => saveUser(tx, user, id, input));
  return { message: id ? 'Korisnik spremljen.' : 'Korisnik dodan.', redirect: id ? undefined : `/postavke/korisnici/${uid}` };
});

export const revokeSessionsAction = action({ module: 'users', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  await assertErpUser(user.companyId, id);
  await transaction((tx) => revokeUserSessions(tx, user, id));
  return { message: 'Korisnik je odjavljen sa svih uređaja.' };
});
