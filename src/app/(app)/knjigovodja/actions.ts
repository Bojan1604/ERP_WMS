'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zIds } from '@/server/zod';
import { markAccountantSent } from '@/server/services/accountant';

/** Skupno: označi/odznači „poslano knjigovođi" (ključevi „out:<id>" i „in:<id>"). */
export const markAccountantSentAction = action(
  { module: 'reports', level: 'ops' },
  z.object({ keys: zIds, sent: zBool }),
  async ({ keys, sent }, user) =>
    transaction(async (tx) => {
      const r = await markAccountantSent(tx, user, keys, sent);
      const n = r.out + r.in;
      return {
        message: sent ? `${n} dokumenata označeno kao poslano knjigovođi.` : `${n} dokumenata vraćeno u „nije poslano".`,
        revalidate: ['/knjigovodja'],
      };
    }),
);
