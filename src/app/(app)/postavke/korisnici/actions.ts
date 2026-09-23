'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zId, zOptId, zReq } from '@/server/zod';
import { revokeUserSessions, saveUser } from '@/server/services/users';

const schema = z.object({
  id: zOptId,
  name: zReq('Ime'),
  email: zReq('E-adresa'),
  role: z.enum(['ADMIN', 'MANAGER', 'SALES', 'WAREHOUSE', 'ACCOUNTANT']),
  active: zBool,
  password: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().nullable()),
  permissions: z.record(z.string()).default({}),
});

export const saveUserAction = action({ module: 'users', level: 'edit' }, schema, async ({ id, ...input }, user) => {
  const uid = await transaction((tx) => saveUser(tx, user, id, input));
  return { message: id ? 'Korisnik spremljen.' : 'Korisnik dodan.', redirect: id ? undefined : `/postavke/korisnici/${uid}` };
});

export const revokeSessionsAction = action({ module: 'users', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  await transaction((tx) => revokeUserSessions(tx, user, id));
  return { message: 'Korisnik je odjavljen sa svih uređaja.' };
});
