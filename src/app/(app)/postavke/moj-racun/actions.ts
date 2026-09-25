'use server';

import { z } from 'zod';
import { passwordsMatch } from '@/lib/zod-checks';
import { userAction } from '@/server/action';
import { createSession } from '@/server/auth';
import { transaction } from '@/server/db';
import { zReq } from '@/server/zod';
import { changeOwnPassword, updateOwnProfile } from '@/server/services/users';
import { confirmTotpSetup, disableOwnTotp, regenerateBackupCodes, startTotpSetup } from '@/server/services/two-factor';

/** Moj račun — svaki prijavljeni korisnik mijenja samo sebe. */
export const saveProfileAction = userAction(z.object({ name: zReq('Ime') }), async (input, user) => {
  await transaction((tx) => updateOwnProfile(tx, user, input));
  return { message: 'Ime spremljeno.' };
});

export const changePasswordAction = userAction(
  z.object({ current: z.string().min(1, 'Upišite trenutnu lozinku'), next: z.string().min(8, 'Nova lozinka mora imati barem 8 znakova'), next2: z.string() }).refine(passwordsMatch, {
    message: 'Nove lozinke se ne podudaraju',
    path: ['next2'],
  }),
  async (input, user) => {
    await transaction((tx) => changeOwnPassword(tx, user, input));
    // stare sesije su odjavljene — ovaj uređaj ostaje prijavljen novom sesijom
    await createSession(user.id);
    return { message: 'Lozinka promijenjena. Ostali uređaji su odjavljeni.' };
  },
);

export const startTotpAction = userAction(z.object({ password: z.string().min(1, 'Upišite lozinku') }), async ({ password }, user) => {
  const r = await transaction((tx) => startTotpSetup(tx, user, password));
  return { data: { secret: r.secret, qr: r.qr }, revalidate: [] };
});

export const confirmTotpAction = userAction(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Upišite šesteroznamenkasti kod') }), async ({ code }, user) => {
  const codes = await transaction((tx) => confirmTotpSetup(tx, user, code));
  return { message: 'Prijava u dva koraka je uključena.', data: { codes } };
});

export const regenerateCodesAction = userAction(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Upišite šesteroznamenkasti kod') }), async ({ code }, user) => {
  const codes = await transaction((tx) => regenerateBackupCodes(tx, user, code));
  return { message: 'Novi rezervni kodovi su izdani — stari više ne vrijede.', data: { codes } };
});

export const disableTotpAction = userAction(z.object({ password: z.string().min(1, 'Upišite lozinku') }), async ({ password }, user) => {
  await transaction((tx) => disableOwnTotp(tx, user, password));
  return { message: 'Prijava u dva koraka je isključena.' };
});
