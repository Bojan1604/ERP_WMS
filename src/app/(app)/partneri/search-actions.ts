'use server';

import { z } from 'zod';
import { userAction } from '@/server/action';
import { AuthError } from '@/server/errors';
import { zOptText } from '@/server/zod';
import { findPartnerOptions } from '@/server/queries/partner-options';
import { can, type PermissionMap, type RoleCode } from '@/domain/permissions';
import { canSearchPartners } from '@/lib/partner-access';
import { toPartnerOption } from '@/lib/partner-option';

/** Pretraga partnera za padajuće odabire (prvih 20 ili po upitu) — cijeli popis se nikad ne šalje u preglednik. */
export const searchPartnerOptions = userAction(
  z.object({ q: zOptText, role: z.enum(['customer', 'supplier', 'any', 'expense']).default('any') }),
  async ({ q, role }, user) => {
    const rows = await findPartnerOptions(user.companyId, { q, role });
    // napomena o partneru pripada prodaji (editori računa i ponuda)
    const note = can(user.perms, 'sales') || can(user.perms, 'partners');
    return { data: rows.map((p) => toPartnerOption(note ? p : { ...p, note: null })), revalidate: [] };
  },
  guardPartnerSearch,
);

function guardPartnerSearch(user: { role: RoleCode; perms: PermissionMap }) {
  if (!canSearchPartners(user)) throw new AuthError('Nemate pravo na popis partnera.', 403);
}
