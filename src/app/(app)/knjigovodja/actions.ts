'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zIds } from '@/server/zod';
import { markAccountantSent } from '@/server/services/accountant';
import { accountantAccess, accountantKeysByFilter } from '@/server/queries/accountant';
import { readAccountantFilters } from '@/domain/accountant';
import { countLabel, plural } from '@/domain/plural';

/** Skupno: označi/odznači „poslano knjigovođi" (ključevi „out:<id>" i „in:<id>"). */
export const markAccountantSentAction = action(
  { module: 'reports', level: 'ops' },
  z.object({ keys: zIds, sent: zBool }),
  async ({ keys, sent }, user) =>
    transaction(async (tx) => {
      const r = await markAccountantSent(tx, user, keys, sent);
      const n = r.out + r.in;
      return {
        message: sent
          ? `${countLabel(n, 'dokument', 'dokumenta', 'dokumenata')} ${plural(n, 'označen', 'označena', 'označeno')} kao poslano knjigovođi.`
          : `${countLabel(n, 'dokument', 'dokumenta', 'dokumenata')} ${plural(n, 'vraćen', 'vraćena', 'vraćeno')} u „nije poslano".`,
        revalidate: ['/knjigovodja'],
      };
    }),
);

/**
 * „Označi sve po filtru": ključevi svih dokumenata koje popis prikazuje za filtre iz URL-a
 * (najviše ACCOUNTANT_ROW_CAP po smjeru) — razrješava poslužitelj, ne stranica.
 */
export const accountantKeysAction = action(
  { module: 'reports', level: 'view' },
  z.object({ qs: z.string().max(2000, 'Predugi filtri.') }),
  async ({ qs }, user) => {
    const f = readAccountantFilters(Object.fromEntries(new URLSearchParams(qs)));
    const keys = await accountantKeysByFilter(user.companyId, f, accountantAccess(user.perms));
    return { data: keys, revalidate: [] };
  },
);
