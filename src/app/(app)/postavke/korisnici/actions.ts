'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { DomainError } from '@/server/errors';
import { zBool, zId, zOptId, zOptText, zReq } from '@/server/zod';
import { inCompany, revokeUserSessions, saveUser } from '@/server/services/users';
import { resetUserTotp } from '@/server/services/two-factor';

const schema = z.object({
  id: zOptId,
  name: zReq('Ime'),
  email: zReq('E-adresa'),
  role: z.enum(['ADMIN', 'MANAGER', 'SALES', 'WAREHOUSE', 'ACCOUNTANT']),
  active: zBool,
  oib: zOptText.refine((v) => v === null || /^\d{11}$/.test(v), 'OIB mora imati 11 znamenki'),
  password: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().nullable()),
  permissions: z.record(z.string()).default({}),
  canDanger: zBool.optional(),
  /** '' = prati firmu, 'yes' = uvijek na odobrenje, 'no' = nikad */
  requireApproval: z.preprocess((v) => (v === 'yes' || v === true ? true : v === 'no' || v === false ? false : null), z.boolean().nullable()).optional(),
});

/** Vanjske korisnike MDM-a (DISTRIBUTOR, CLIENT) ERP ne uređuje — to se radi u MDM → Organizacije. */
async function assertErpUser(companyId: string, id: string) {
  const u = await db.user.findFirst({ where: { id, ...inCompany(companyId) }, select: { role: true } });
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

/** Administrator poništava korisniku prijavu u dva koraka (izgubljen mobitel). */
export const resetTotpAction = action({ module: 'users', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  if (user.role !== 'ADMIN') throw new DomainError('Prijavu u dva koraka poništava samo administrator.');
  await assertErpUser(user.companyId, id);
  await transaction((tx) => resetUserTotp(tx, user, id, user.companyId));
  return { message: 'Prijava u dva koraka je poništena — korisnik se prijavljuje samo lozinkom.' };
});
