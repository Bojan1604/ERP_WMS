import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { readMeta, type InvoiceFiscalMeta } from './issue';

/**
 * Zauzimanje računa za slanje u CIS / posredniku — da dva istodobna poziva
 * (afterIssue nakon izdavanja, „Ponovi fiskalizaciju", „Pošalji eRačun",
 * „Naknadna fiskalizacija" u drugoj kartici…) ne pošalju isti račun dvaput.
 *
 * Kako: prije mrežnog poziva jedan atomski UPDATE upisuje oznaku
 * `eInvoice.sending = { token, at, kind }`, ali samo ako oznake nema ili je
 * zastarjela. Postgres zaključava redak za UPDATE, pa od dva istodobna poziva
 * uspije samo jedan (drugi dobije 0 redaka i ništa ne šalje). Na kraju se
 * oznaka briše u istom upisu kojim se sprema ishod.
 *
 * Zašto u JSON-u, a ne u stanju: FiscalStatus nema međustanje „šalje se", a
 * `fiscalAttempts` (usporedi-i-povećaj) sam ne bi spriječio drugo slanje nakon
 * što prvo zauzme račun, a još nije završilo. Oznaka s vremenom rješava i pad
 * procesa usred slanja: nakon CLAIM_STALE_MS se smatra napuštenom i račun se
 * može ponovno poslati. To je znatno dulje od najduljeg mrežnog poziva
 * (CIS 10 s, posrednik 30 s + provjera stanja 30 s), pa živo slanje nikad ne
 * zastari.
 */
export const CLAIM_STALE_MS = 5 * 60_000;

export type ClaimKind = 'cis' | 'einvoice';

export interface Claim {
  token: string;
  /** Podaci o fiskalizaciji iz trenutka zauzimanja (bez oznake). */
  meta: InvoiceFiscalMeta;
  fiscalAttempts: number;
}

/** Zauzmi račun; null = netko ga upravo šalje ili više ne treba slati. */
export async function claimSend(invoiceId: string, companyId: string, kind: ClaimKind, now = new Date()): Promise<Claim | null> {
  const token = randomUUID();
  const at = now.toISOString();
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const rows = await db.$queryRaw<Array<{ eInvoice: unknown; fiscalAttempts: number }>>`
    UPDATE "Invoice"
    SET "eInvoice" = jsonb_set(
          CASE WHEN jsonb_typeof("eInvoice") = 'object' THEN "eInvoice" ELSE '{}'::jsonb END,
          '{sending}',
          jsonb_build_object('token', ${token}::text, 'at', ${at}::text, 'kind', ${kind}::text)
        ),
        "updatedAt" = now()
    WHERE "id" = ${invoiceId} AND "companyId" = ${companyId} AND "status" = 'ISSUED'
      AND (${kind}::text <> 'cis' OR "jir" IS NULL)
      AND (${kind}::text <> 'einvoice' OR "fiscalStatus" <> 'SENT')
      AND (
        jsonb_typeof("eInvoice") IS DISTINCT FROM 'object'
        OR "eInvoice"->'sending' IS NULL
        OR coalesce("eInvoice"->'sending'->>'at', '') < ${staleBefore}::text
      )
    RETURNING "eInvoice", "fiscalAttempts"`;
  if (!rows.length) return null;
  return { token, meta: withoutMarker(rows[0].eInvoice), fiscalAttempts: rows[0].fiscalAttempts };
}

/** Podaci bez oznake zauzimanja (za upis ishoda). */
export function withoutMarker(v: unknown): InvoiceFiscalMeta {
  const { sending: _s, ...rest } = readMeta(v) as InvoiceFiscalMeta & { sending?: unknown };
  return rest;
}

/** Uvjet „oznaka je još moja" (za upis ishoda ili otpuštanje). */
export const ownsClaim = (token: string) => ({ eInvoice: { path: ['sending', 'token'], equals: token } }) satisfies Prisma.InvoiceWhereInput;

/** Otpuštanje bez upisa ishoda (npr. ništa nije poslano). */
export async function releaseClaim(invoiceId: string, token: string, meta: InvoiceFiscalMeta) {
  await db.invoice
    .updateMany({ where: { id: invoiceId, ...ownsClaim(token) }, data: { eInvoice: meta as Prisma.InputJsonValue } })
    .catch((e) => console.error('[fiscal] otpuštanje', e));
}
