import 'server-only';
import nodemailer, { type Transporter } from 'nodemailer';
import { db } from '../db';
import { DomainError } from '../errors';
import { decryptSecret } from '../fiscal/crypto';

/**
 * SMTP postavke firme i nodemailer transport. Lozinka je u bazi šifrirana
 * (`encryptSecret`, isti mehanizam kao lozinka fiskalnog certifikata) i
 * dešifrira se tek pri slanju — nikad ne ide u preglednik.
 */
export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
  fromName: string;
  replyTo: string | null;
  bccSelf: boolean;
}

/** Je li slanje podešeno (poslužitelj i adresa pošiljatelja). Za sučelje — bez dešifriranja lozinke. */
export const isMailConfigured = (c: { smtpHost: string | null; mailFrom: string | null; email: string | null }) => !!c.smtpHost?.trim() && !!(c.mailFrom?.trim() || c.email?.trim());

export async function loadMailConfig(companyId: string): Promise<MailConfig> {
  const c = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { name: true, email: true, smtpHost: true, smtpPort: true, smtpSecure: true, smtpUser: true, smtpPassword: true, mailFrom: true, mailReplyTo: true, mailBccSelf: true },
  });
  if (!isMailConfigured(c)) throw new DomainError('Slanje e-pošte nije podešeno — upišite SMTP poslužitelj i adresu pošiljatelja u Postavke → E-pošta.');
  let password: string | null = null;
  try {
    password = decryptSecret(c.smtpPassword);
  } catch {
    throw new DomainError('SMTP lozinka se ne može dešifrirati (promijenjen AUTH_SECRET?) — upišite je ponovno u Postavke → E-pošta.');
  }
  return {
    host: c.smtpHost!.trim(),
    port: c.smtpPort ?? (c.smtpSecure ? 465 : 587),
    secure: c.smtpSecure,
    user: c.smtpUser?.trim() || null,
    password,
    from: (c.mailFrom?.trim() || c.email?.trim())!,
    fromName: c.name,
    replyTo: c.mailReplyTo?.trim() || null,
    bccSelf: c.mailBccSelf,
  };
}

type Factory = (cfg: MailConfig) => Transporter;

const smtpFactory: Factory = (cfg) =>
  nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

let factory: Factory = smtpFactory;

/**
 * Samo za testove: zamjena transporta (npr. `nodemailer.createTransport({ jsonTransport: true })`).
 * `null` vraća pravi SMTP.
 */
export function setMailTransportFactory(f: Factory | null) {
  factory = f ?? smtpFactory;
}

export const createTransport = (cfg: MailConfig) => factory(cfg);
