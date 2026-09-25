import 'server-only';
import type { SessionUser } from '../auth';
import { DomainError } from '../errors';
import type { SendDocumentEmailInput } from '@/domain/documents';

export type { SendDocumentEmailInput, MailKind } from '@/domain/documents';

/** Rezultat slanja (za toast i dnevnik). */
export interface SendResult {
  messageId: string | null;
}

/**
 * Slanje dokumenta e-poštom (SMTP postavke firme, predlošci, PDF u privitku,
 * zapis u EmailLog). Pravo i ulaz su već provjereni u `sendDocumentEmail`
 * (server/mail/actions.ts); ovdje se zapis mora tražiti unutar `user.companyId`.
 *
 * UGOVOR (faza 0): stub — implementira područje A (nodemailer).
 */
export async function sendDocumentEmailImpl(user: SessionUser, input: SendDocumentEmailInput): Promise<SendResult> {
  void user;
  void input;
  throw new DomainError('Slanje e-pošte još nije podešeno.');
}
