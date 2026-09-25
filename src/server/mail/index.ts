import 'server-only';
import type { SessionUser } from '../auth';
import { db, transaction } from '../db';
import { audit } from '../audit';
import { DomainError } from '../errors';
import { renderDocumentPdf } from '../pdf';
import { buildAccountantZip } from '../queries/accountant-export';
import { canSeeCost } from '@/domain/permissions';
import { splitAddresses } from '@/domain/mail';
import { today } from '@/domain/dates';
import type { SendDocumentEmailInput } from '@/domain/documents';
import { createTransport, loadMailConfig } from './transport';
import { resolveDoc } from './draft';

export type { SendDocumentEmailInput, MailKind } from '@/domain/documents';
export { buildEmailDraft, type EmailDraft } from './draft';

/** Rezultat slanja (za toast i dnevnik). */
export interface SendResult {
  messageId: string | null;
}

export interface OutgoingMail {
  /** Vrsta za dnevnik (EmailLog.kind): invoice, quote, …, test. */
  kind: string;
  entityId: string | null;
  to: string;
  cc?: string | null;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  /** Sažetak za dnevnik promjena (audit). */
  summary: string;
}

type Actor = Pick<SessionUser, 'id' | 'name' | 'companyId'>;

/**
 * Slanje jedne poruke SMTP-om firme. Svaki pokušaj ide u EmailLog (SENT ili
 * FAILED s porukom greške); uspjeh i u dnevnik promjena. Greška SMTP-a ide
 * korisniku kao DomainError s razumljivim tekstom.
 */
export async function deliverMail(actor: Actor, mail: OutgoingMail): Promise<SendResult> {
  const cfg = await loadMailConfig(actor.companyId);
  const to = splitAddresses(mail.to);
  const cc = splitAddresses(mail.cc);
  const log = { companyId: actor.companyId, kind: mail.kind, entityId: mail.entityId, to: to.join(', ').slice(0, 1000), cc: cc.length ? cc.join(', ').slice(0, 1000) : null, subject: mail.subject.slice(0, 300), sentBy: actor.name };
  let messageId: string | null = null;
  try {
    const info = await createTransport(cfg).sendMail({
      from: { name: cfg.fromName, address: cfg.from },
      to,
      cc: cc.length ? cc : undefined,
      bcc: cfg.bccSelf ? cfg.from : undefined,
      replyTo: cfg.replyTo ?? undefined,
      subject: mail.subject,
      text: mail.text,
      attachments: mail.attachments,
    });
    messageId = typeof info?.messageId === 'string' ? info.messageId : null;
  } catch (e) {
    const error = smtpError(e);
    await db.emailLog.create({ data: { ...log, status: 'FAILED', error: error.slice(0, 1000) } }).catch((x) => console.error('[mail] log', x));
    throw new DomainError(`Poruka nije poslana: ${error}`);
  }
  await transaction(async (tx) => {
    await tx.emailLog.create({ data: { ...log, status: 'SENT', messageId } });
    await audit(tx, actor, { entity: mail.kind === 'accountant-zip' ? 'accountant' : mail.kind, entityId: mail.entityId, action: 'email', summary: `${mail.summary} → ${log.to}` });
  });
  return { messageId };
}

/** Razumljiva poruka za najčešće greške SMTP-a. */
function smtpError(e: unknown): string {
  const err = e as { code?: string; responseCode?: number; message?: string };
  if (err?.code === 'EAUTH') return 'SMTP poslužitelj je odbio korisničko ime ili lozinku.';
  if (err?.code === 'ECONNECTION' || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' || err?.code === 'EDNS') return 'SMTP poslužitelj nije dostupan — provjerite adresu i port.';
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ESOCKET') return 'Veza sa SMTP poslužiteljem je istekla ili prekinuta (provjerite port i TLS).';
  if (err?.code === 'EENVELOPE') return 'Poslužitelj je odbio adresu primatelja ili pošiljatelja.';
  return (err?.message || 'nepoznata greška').slice(0, 500);
}

/**
 * Slanje dokumenta e-poštom (SMTP postavke firme, PDF u privitku, zapis u
 * EmailLog). Pravo i ulaz su već provjereni u `sendDocumentEmail`
 * (server/mail/actions.ts); zapis se traži unutar `user.companyId`.
 */
export async function sendDocumentEmailImpl(user: SessionUser, input: SendDocumentEmailInput): Promise<SendResult> {
  const doc = await resolveDoc(user, input.kind, input.id);
  const attachments: NonNullable<OutgoingMail['attachments']> = [];
  if (input.attachPdf && doc.pdf) {
    const pdf = await renderDocumentPdf(doc.pdf.kind, doc.pdf.id, user.companyId, { showCost: canSeeCost(user.perms) });
    attachments.push({ filename: pdf.fileName, content: pdf.buffer, contentType: 'application/pdf' });
  }
  if (input.attachPdf && doc.zip) {
    // privitci veći od ~20 MB obično ne prolaze kroz poslužitelje pošte
    const z = await buildAccountantZip(user.companyId, doc.zip.keys, 20 * 1024 * 1024, doc.zip.allowed);
    attachments.push({ filename: `knjigovodja-${today()}.zip`, content: z.buffer, contentType: 'application/zip' });
  }
  return deliverMail(user, {
    kind: input.kind,
    entityId: doc.zip ? null : doc.entityId,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    text: input.body,
    attachments,
    summary: `E-pošta: ${doc.title}${attachments.length ? ` (privitak ${attachments.map((a) => a.filename).join(', ')})` : ''}`,
  });
}

/** Probna poruka iz postavki pošte. */
export async function sendTestEmail(actor: Actor, to: string): Promise<SendResult> {
  const c = await db.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { name: true } });
  return deliverMail(actor, {
    kind: 'test',
    entityId: null,
    to,
    subject: `Probna poruka — ${c.name}`,
    text: `Ovo je probna poruka iz ERP/WMS-a (${c.name}).\n\nAko ste je primili, slanje e-pošte je ispravno podešeno.`,
    summary: 'Probna e-poruka',
  });
}
