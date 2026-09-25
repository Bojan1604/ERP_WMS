'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zOptInt, zOptText } from '@/server/zod';
import { saveMailSettings, saveMailTemplates } from '@/server/mail/settings';
import { sendTestEmail } from '@/server/mail';
import { MAIL_TEMPLATE_KINDS, type MailTemplateKind } from '@/domain/mail';

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const zOptEmail = (label: string) => zOptText.refine((v) => !v || EMAIL.test(v), `${label}: neispravna e-adresa`);

const zSettings = z.object({
  smtpHost: zOptText.refine((v) => !v || /^[A-Za-z0-9.-]{1,253}$/.test(v), 'Neispravan naziv poslužitelja (npr. smtp.gmail.com)'),
  smtpPort: zOptInt.refine((v) => v === null || (v >= 1 && v <= 65535), 'Port mora biti između 1 i 65535'),
  smtpSecure: zBool,
  smtpUser: zOptText.refine((v) => !v || v.length <= 200, 'Korisničko ime je predugo'),
  password: zOptText.refine((v) => !v || v.length <= 500, 'Lozinka je preduga'),
  clearPassword: zBool,
  mailFrom: zOptEmail('Pošiljatelj'),
  mailReplyTo: zOptEmail('Odgovor na'),
  mailBccSelf: zBool,
});

export const saveMailSettingsAction = action({ module: 'settings', level: 'edit' }, zSettings, async (input, user) => {
  await transaction((tx) => saveMailSettings(tx, user, input));
  return { message: 'Postavke e-pošte su spremljene.', revalidate: ['/postavke/posta'] };
});

const zTpl = z.object({ subject: z.string().trim().max(300, 'Naslov je predug'), body: z.string().max(10_000, 'Tekst je predug') });
const zTemplates = z.object(Object.fromEntries(MAIL_TEMPLATE_KINDS.map((k) => [k, zTpl])) as Record<MailTemplateKind, typeof zTpl>);

export const saveMailTemplatesAction = action({ module: 'settings', level: 'edit' }, zTemplates, async (input, user) => {
  await transaction((tx) => saveMailTemplates(tx, user, input));
  return { message: 'Predlošci poruka su spremljeni.', revalidate: ['/postavke/posta'] };
});

export const sendTestEmailAction = action(
  { module: 'settings', level: 'edit' },
  z.object({ to: z.string().trim().regex(EMAIL, 'Upišite ispravnu e-adresu primatelja') }),
  async ({ to }, user) => {
    await sendTestEmail(user, to);
    return { message: `Probna poruka je poslana na ${to}.`, revalidate: ['/postavke/posta'] };
  },
);
