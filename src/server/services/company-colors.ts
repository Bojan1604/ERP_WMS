import 'server-only';
import { z } from 'zod';
import type { Tx } from '../db';
import { audit, diff } from '../audit';
import { assert } from '../errors';
import type { Actor } from './items';
import { DEFAULT_BRAND_COLOR, DEFAULT_MENU_COLOR, normalizeHex, storedColor } from '@/domain/brand-colors';

/** Prazno = zadana boja; inače #rrggbb (dopušten i kratki oblik #abc). */
const zColor = z.preprocess(
  (v) => (v === undefined || v === null || (typeof v === 'string' && !v.trim()) ? null : typeof v === 'string' ? v.trim() : v),
  z.string().refine((v) => !!normalizeHex(v), 'Boja mora biti oblika #rrggbb').nullable(),
);

export const companyColorsSchema = z.object({ brandColor: zColor, menuColor: zColor });
export type CompanyColorsInput = z.infer<typeof companyColorsSchema>;

/** Boje firme (naglasak, izbornik); zadana boja se sprema kao null. */
export async function saveCompanyColors(tx: Tx, actor: Actor, input: CompanyColorsInput) {
  for (const v of [input.brandColor, input.menuColor]) assert(v === null || !!normalizeHex(v), 'Boja mora biti oblika #rrggbb.');
  const before = await tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { brandColor: true, menuColor: true } });
  const data = { brandColor: storedColor(input.brandColor, DEFAULT_BRAND_COLOR), menuColor: storedColor(input.menuColor, DEFAULT_MENU_COLOR) };
  const changes = diff(before, data);
  if (!Object.keys(changes).length) return data;
  await tx.company.update({ where: { id: actor.companyId }, data });
  const reset = !data.brandColor && !data.menuColor;
  await audit(tx, actor, { entity: 'company', entityId: actor.companyId, action: 'update', summary: reset ? 'Boje firme vraćene na zadane' : 'Boje firme izmijenjene', diff: changes as object });
  return data;
}
