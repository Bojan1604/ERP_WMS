import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { escapeLike } from '@/lib/like';
import { FOLD_FROM, FOLD_TO, fold } from '@/lib/fold';
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

/**
 * Naziv/grad bez dijakritika i velikih slova — izraz mora biti isti kao u indeksu
 * `Partner_name_fold_trgm_idx` (migracija 0016_unaccent), inače se indeks ne koristi.
 * Nizovi su konstante iz koda (ne korisnički unos), pa idu izravno u SQL.
 */
const foldCol = (col: 'name' | 'city') => Prisma.raw(`lower(translate(p."${col}", '${FOLD_FROM}', '${FOLD_TO}'))`);

function roleSql(role: PartnerRole): Prisma.Sql {
  if (role === 'customer') return Prisma.sql`AND p."isCustomer"`;
  if (role === 'supplier') return Prisma.sql`AND p."isSupplier"`;
  if (role === 'expense') return Prisma.sql`AND (p."isSupplier" OR EXISTS (SELECT 1 FROM "Expense" e WHERE e."partnerId" = p.id))`;
  return Prisma.empty;
}

export async function findPartnerOptions(companyId: string, opts: { q?: string | null; role?: PartnerRole; take?: number } = {}): Promise<PartnerOpt[]> {
  const q = opts.q?.trim().slice(0, 100);
  const role = opts.role ?? 'any';
  const take = Math.min(opts.take ?? PARTNER_OPTIONS_TAKE, 50);
  if (!q) {
    return db.partner.findMany({ where: { companyId, ...partnerRoleWhere(role) }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take, select });
  }
  // pretraga naziva i grada bez dijakritika („slasticarnica" → „Slastičarnica"), OIB od početka
  const like = `%${escapeLike(fold(q))}%`;
  const ids = await db.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM "Partner" p
    WHERE p."companyId" = ${companyId} ${roleSql(role)}
      AND (${foldCol('name')} LIKE ${like} OR ${foldCol('city')} LIKE ${like} OR p."oib" LIKE ${`${escapeLike(q)}%`})
    ORDER BY p."name", p.id
    LIMIT ${take}`;
  if (!ids.length) return [];
  const rows = await db.partner.findMany({ where: { companyId, id: { in: ids.map((r) => r.id) } }, select });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((r) => byId.get(r.id) ?? []);
}

/** Odabrani partneri (vrijednost polja ili filtra iz URL-a) — bez obzira na ulogu. */
export async function partnerOptionsByIds(companyId: string, ids: Array<string | null | undefined>): Promise<PartnerOpt[]> {
  const list = [...new Set(ids.filter((x): x is string => !!x))].slice(0, 200);
  if (!list.length) return [];
  return db.partner.findMany({ where: { companyId, id: { in: list } }, orderBy: { name: 'asc' }, select });
}
