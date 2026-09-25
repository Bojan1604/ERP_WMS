'use server';

import { z } from 'zod';
import { requireUser } from '../auth';
import { AuthError } from '../errors';
import { toError } from '../action';
import { sendDocumentEmailImpl, type SendResult } from './index';
import { can, isExternalRole } from '@/domain/permissions';
import { MAIL_KINDS, MAIL_KIND_ACCESS, type SendDocumentEmailInput } from '@/domain/documents';
import type { ActionResult } from '@/lib/action-result';

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
/** Jedna ili više adresa odvojenih zarezom/točka-zarezom. */
const zEmails = (label: string) =>
  z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v.split(/[,;]/).map((x) => x.trim()).filter(Boolean).every((x) => EMAIL.test(x)), `${label}: neispravna e-adresa.`);

const schema = z.object({
  kind: z.enum(MAIL_KINDS),
  id: z.string().min(1).max(200),
  to: zEmails('Prima').refine((v) => v.length > 0, 'Upišite e-adresu primatelja.'),
  cc: z.preprocess((v) => (typeof v === 'string' && !v.trim() ? undefined : v), zEmails('Kopija').optional()),
  subject: z.string().trim().min(1, 'Upišite naslov poruke.').max(300),
  body: z.string().max(20_000),
  attachPdf: z.boolean(),
});

/**
 * Server akcija: pošalji dokument e-poštom. Pravo po vrsti (MAIL_KIND_ACCESS):
 * račun/ponuda/predračun/otpremnica → prodaja (uređivanje), servis → servis,
 * partner → partneri (pregled), knjigovođa → izvještaji (ops).
 * Potpis je konačan (faza 0); slanje implementira područje A u `sendDocumentEmailImpl`.
 */
export async function sendDocumentEmail(input: SendDocumentEmailInput): Promise<ActionResult<SendResult>> {
  try {
    const user = await requireUser();
    const data = schema.parse(input);
    const access = MAIL_KIND_ACCESS[data.kind];
    if (isExternalRole(user.role) || !can(user.perms, access.module, access.level)) throw new AuthError('Nemate pravo slanja ovog dokumenta.', 403);
    const res = await sendDocumentEmailImpl(user, data);
    return { ok: true, data: res, message: `Poruka je poslana na ${data.to}.` };
  } catch (e) {
    return toError(e);
  }
}
