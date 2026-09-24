import 'server-only';
import { cache } from 'react';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { AuthError } from '../errors';
import type { SessionUser } from '../auth';
import type { Level } from '@/domain/permissions';

/**
 * Opseg MDM-a za korisnika:
 *   • korisnik firme vlasnika (SuperUser, zaposlenici) — sve organizacije i uređaji firme (orgIds = null)
 *   • DISTRIBUTOR — svoja organizacija i njeni klijenti
 *   • CLIENT — samo svoja organizacija
 * Svaki MDM upit gradi `where` iz opsega; id iz URL-a/obrasca provjerava se kroz assert*.
 */
export interface MdmScope {
  companyId: string;
  /** Korisnik firme vlasnika sustava. */
  owner: boolean;
  /** null = sve organizacije firme. */
  orgIds: string[] | null;
  /** Vlastita organizacija vanjskog korisnika. */
  homeOrgId: string | null;
  level: Level;
  userName: string;
  userId: string;
}

export const getMdmScope = cache(async (user: SessionUser): Promise<MdmScope> => {
  const base = { companyId: user.companyId, level: user.perms.mdm, userName: user.name, userId: user.id };
  if (!user.mdmOrgId) return { ...base, owner: true, orgIds: null, homeOrgId: null };
  if (user.role === 'DISTRIBUTOR') {
    const children = await db.mdmOrg.findMany({ where: { companyId: user.companyId, parentId: user.mdmOrgId }, select: { id: true } });
    return { ...base, owner: false, orgIds: [user.mdmOrgId, ...children.map((c) => c.id)], homeOrgId: user.mdmOrgId };
  }
  return { ...base, owner: false, orgIds: [user.mdmOrgId], homeOrgId: user.mdmOrgId };
});

export const orgWhere = (s: MdmScope): Prisma.MdmOrgWhereInput => ({ companyId: s.companyId, ...(s.orgIds ? { id: { in: s.orgIds } } : {}) });

/** Uređaji u opsegu. Uređaji bez organizacije (na čekanju) vidi samo vlasnik. */
export const deviceWhere = (s: MdmScope): Prisma.MdmDeviceWhereInput => ({
  companyId: s.companyId,
  ...(s.orgIds ? { orgId: { in: s.orgIds } } : {}),
});

/** Profili, aplikacije i datoteke: vlastite organizacije + zajednički (orgId null) vlasnika. */
export const sharedWhere = (s: MdmScope) => ({
  companyId: s.companyId,
  ...(s.orgIds ? { OR: [{ orgId: null }, { orgId: { in: s.orgIds } }] } : {}),
});

export function assertOrgInScope(s: MdmScope, orgId: string | null | undefined): asserts orgId is string {
  if (!orgId) throw new AuthError('Organizacija nije odabrana.', 403);
  if (s.orgIds && !s.orgIds.includes(orgId)) throw new AuthError('Organizacija nije dostupna.', 403);
}

export async function loadDeviceInScope(s: MdmScope, deviceId: string) {
  const d = await db.mdmDevice.findFirst({ where: { id: deviceId, ...deviceWhere(s) } });
  if (!d) throw new AuthError('Uređaj nije dostupan.', 403);
  return d;
}

/** Smije li korisnik mijenjati zajednički resurs (orgId null = samo vlasnik). */
export function canEditShared(s: MdmScope, orgId: string | null): boolean {
  if (orgId === null) return s.owner;
  return !s.orgIds || s.orgIds.includes(orgId);
}
