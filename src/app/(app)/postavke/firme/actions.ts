'use server';

import { z } from 'zod';
import { userAction } from '@/server/action';
import { AuthError } from '@/server/errors';
import { transaction } from '@/server/db';
import type { SessionUser } from '@/server/auth';
import { zBool, zId, zReq } from '@/server/zod';
import { createCompany, deleteCompany, setCompanyAccess, switchCompany } from '@/server/services/companies';
import { removeStoredFiles } from '@/server/mdm/wipe';

const adminOnly = (u: SessionUser) => {
  if (u.role !== 'ADMIN') throw new AuthError('Firme otvara i briše samo administrator.', 403);
};

/** Prebacivanje firme iz zaglavlja — svaki korisnik, samo u firme kojima ima pristup. */
export const switchCompanyAction = userAction(z.object({ companyId: zId }), async ({ companyId }, user) => {
  if (user.mdmOrgId) throw new AuthError('Vanjski korisnici MDM-a ne mijenjaju firmu.', 403);
  const r = await transaction((tx) => switchCompany(tx, user, companyId));
  return { message: `Radite u firmi „${r.name}".`, redirect: '/' };
});

export const createCompanyAction = userAction(
  z.object({ name: zReq('Naziv firme'), country: zReq('Država'), currency: zReq('Valuta'), copyLookups: zBool, switchTo: zBool }),
  async ({ switchTo, ...input }, user) => {
    const c = await transaction(async (tx) => {
      const created = await createCompany(tx, user, input);
      if (switchTo) await switchCompany(tx, user, created.id);
      return created;
    });
    return { message: `Firma „${c.name}" je otvorena.`, redirect: switchTo ? '/postavke' : '/postavke/firme' };
  },
  adminOnly,
);

export const companyAccessAction = userAction(z.object({ userId: zId, companyId: zId, grant: zBool }), async (input, user) => {
  await transaction((tx) => setCompanyAccess(tx, user, input.userId, input.companyId, input.grant));
  return { message: input.grant ? 'Pristup dodan.' : 'Pristup oduzet.' };
}, adminOnly);

export const deleteCompanyAction = userAction(z.object({ companyId: zId, confirmName: zReq('Naziv firme') }), async (input, user) => {
  const { mdmFiles } = await transaction((tx) => deleteCompany(tx, user, input.companyId, input.confirmName));
  await removeStoredFiles(mdmFiles);
  return { message: 'Firma je obrisana.' };
}, adminOnly);
