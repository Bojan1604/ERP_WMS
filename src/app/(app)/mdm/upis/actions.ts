'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { getMdmScope } from '@/server/mdm/scope';
import { createEnrollToken, enrollByCode, revokeEnrollToken } from '@/server/mdm/enroll';
import { DomainError } from '@/server/errors';
import { RateLimiter } from '@/server/mdm/agent-auth';
import { zId, zOptDate, zOptId, zOptInt, zOptText } from '@/server/zod';

/** Kod ima 6 znamenki — ograničenje pokušaja po korisniku sprječava pogađanje. */
const codeAttempts = new RateLimiter(10, 10 * 60_000);

export const enrollAction = action(
  { module: 'mdm', level: 'edit' },
  z.object({ code: z.string().trim().min(1, 'Upišite kod'), orgId: zId, siteId: zOptId, name: zOptText, profileId: zOptId }),
  async (input, user) => {
    const wait = codeAttempts.take(user.id);
    if (wait) throw new DomainError(`Previše pokušaja upisa. Pokušajte ponovno za ${Math.ceil(wait / 60)} min.`);
    const scope = await getMdmScope(user);
    const d = await transaction((tx) => enrollByCode(tx, scope, input));
    return { message: `Uređaj ${d.name} je upisan.`, redirect: `/mdm/uredaji/${d.id}` };
  },
);

export const createTokenAction = action(
  { module: 'mdm', level: 'edit' },
  z.object({ orgId: zId, siteId: zOptId, label: zOptText, maxUses: zOptInt, expiresAt: zOptDate }),
  async (input, user) => {
    const scope = await getMdmScope(user);
    const t = await transaction((tx) => createEnrollToken(tx, scope, input));
    return { message: 'Ključ za upis izrađen.', redirect: `/mdm/upis?kljuc=${t.id}` };
  },
);

export const revokeTokenAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => revokeEnrollToken(tx, scope, id));
  return { message: 'Ključ opozvan.', redirect: '/mdm/upis' };
});
