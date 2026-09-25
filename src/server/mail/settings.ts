import 'server-only';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { audit } from '../audit';
import { encryptSecret } from '../fiscal/crypto';
import type { Actor } from '../services/items';
import { MAIL_DEFAULTS, MAIL_TEMPLATE_KINDS, type MailTemplates } from '@/domain/mail';

export interface MailSettingsInput {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  /** Nova lozinka; null = ne mijenja se. */
  password: string | null;
  clearPassword: boolean;
  mailFrom: string | null;
  mailReplyTo: string | null;
  mailBccSelf: boolean;
}

const FIELDS = ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'mailFrom', 'mailReplyTo', 'mailBccSelf'] as const;

/** SMTP postavke firme; lozinka se sprema šifrirana (AES-256-GCM, kao lozinka certifikata) i ne upisuje u dnevnik. */
export async function saveMailSettings(tx: Tx, actor: Actor, input: MailSettingsInput) {
  const before = await tx.company.findUniqueOrThrow({
    where: { id: actor.companyId },
    select: { smtpHost: true, smtpPort: true, smtpSecure: true, smtpUser: true, smtpPassword: true, mailFrom: true, mailReplyTo: true, mailBccSelf: true },
  });
  const data: Prisma.CompanyUpdateInput = {
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpUser: input.smtpUser,
    mailFrom: input.mailFrom,
    mailReplyTo: input.mailReplyTo,
    mailBccSelf: input.mailBccSelf,
  };
  if (input.password) data.smtpPassword = encryptSecret(input.password);
  else if (input.clearPassword) data.smtpPassword = null;
  await tx.company.update({ where: { id: actor.companyId }, data });

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of FIELDS) if (before[k] !== input[k]) changes[k] = { from: before[k], to: input[k] };
  if (input.password) changes.smtpPassword = { from: before.smtpPassword ? 'postavljena' : null, to: 'nova lozinka' };
  else if (input.clearPassword && before.smtpPassword) changes.smtpPassword = { from: 'postavljena', to: null };
  if (Object.keys(changes).length) {
    await audit(tx, actor, { entity: 'company', entityId: actor.companyId, action: 'mail-settings', summary: 'Postavke e-pošte izmijenjene', diff: changes as object });
  }
}

/** Predlošci poruka; tekst jednak zadanom se ne sprema (ostaje prazno = zadano, prati buduće promjene). */
export async function saveMailTemplates(tx: Tx, actor: Actor, templates: MailTemplates) {
  const stored: Record<string, { subject: string; body: string }> = {};
  for (const k of MAIL_TEMPLATE_KINDS) {
    const t = templates[k];
    const subject = t.subject.trim() === MAIL_DEFAULTS[k].subject ? '' : t.subject.trim();
    const body = t.body.trim() === MAIL_DEFAULTS[k].body ? '' : t.body.replace(/\s+$/, '');
    if (subject || body) stored[k] = { subject, body };
  }
  await tx.company.update({ where: { id: actor.companyId }, data: { mailTemplates: stored } });
  await audit(tx, actor, { entity: 'company', entityId: actor.companyId, action: 'mail-templates', summary: `Predlošci e-pošte izmijenjeni (${Object.keys(stored).length} prilagođenih)` });
}
