'use server';

import { z } from 'zod';
import { userAction } from '@/server/action';
import { AuthError } from '@/server/errors';
import { zOptText } from '@/server/zod';
import { findPartnerOptions } from '@/server/queries/partner-options';
import { can, EXTERNAL_ROLES, type Module } from '@/domain/permissions';
import { toPartnerOption } from '@/lib/partner-option';

/** Moduli čiji ekrani biraju partnera (filtri i editori). */
const PARTNER_MODULES: Module[] = ['partners', 'sales', 'rentals', 'purchasing', 'expenses', 'service', 'warehouse', 'reports', 'mdm', 'costs'];

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

function guardPartnerSearch(user: { role: Parameters<typeof EXTERNAL_ROLES.includes>[0]; perms: Parameters<typeof can>[0] }) {
  if (EXTERNAL_ROLES.includes(user.role) || !PARTNER_MODULES.some((m) => can(user.perms, m))) throw new AuthError('Nemate pravo na popis partnera.', 403);
}
