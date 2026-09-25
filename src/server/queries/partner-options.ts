import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { escapeLike } from '@/lib/like';
import type { PartnerOpt, PartnerRole } from '@/lib/partner-option';

/**
 * Partneri za padajuće odabire: nikad cijeli popis (firma može imati tisuće partnera) —
 * prvih N po nazivu ili pretraga na poslužitelju, a odabrani se razrješavaju po id-u.
 */
const select = { id: true, name: true, city: true, country: true, note: true, paymentTermDays: true, excluded: true, vatCategoryOverride: true } satisfies Prisma.PartnerSelect;

export const PARTNER_OPTIONS_TAKE = 20;

export function partnerRoleWhere(role: PartnerRole): Prisma.PartnerWhereInput {
  if (role === 'customer') return { isCustomer: true };
  if (role === 'supplier') return { isSupplier: true };
  if (role === 'expense') return { OR: [{ isSupplier: true }, { expenses: { some: {} } }] };
  return {};
}

export async function findPartnerOptions(companyId: string, opts: { q?: string | null; role?: PartnerRole; take?: number } = {}): Promise<PartnerOpt[]> {
  const q = opts.q?.trim().slice(0, 100);
  const lit = q ? escapeLike(q) : '';
  return db.partner.findMany({
    where: {
      companyId,
      AND: [
        partnerRoleWhere(opts.role ?? 'any'),
        ...(q ? [{ OR: [{ name: { contains: lit, mode: 'insensitive' as const } }, { oib: { startsWith: lit } }, { city: { contains: lit, mode: 'insensitive' as const } }] }] : []),
      ],
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: Math.min(opts.take ?? PARTNER_OPTIONS_TAKE, 50),
    select,
  });
}

/** Odabrani partneri (vrijednost polja ili filtra iz URL-a) — bez obzira na ulogu. */
export async function partnerOptionsByIds(companyId: string, ids: Array<string | null | undefined>): Promise<PartnerOpt[]> {
  const list = [...new Set(ids.filter((x): x is string => !!x))].slice(0, 200);
  if (!list.length) return [];
  return db.partner.findMany({ where: { companyId, id: { in: list } }, orderBy: { name: 'asc' }, select });
}
