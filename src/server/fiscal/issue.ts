import 'server-only';
import type { Company, Partner, PaymentMethod, Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { DomainError } from '../errors';
import { fiscalRoute, missingForCis, zkiInput, type FiscalRoute } from '@/domain/fiscal';
import { companyCert } from './cert';
import { computeZki, demoKey } from './zki';

/**
 * Podaci o fiskalizaciji koji se pri izdavanju spremaju u `Invoice.eInvoice`
 * (JSON), da bi naknadna dostava poslala iste podatke kao na ispisanom računu
 * i kad se u međuvremenu promijene postavke firme ili korisnika.
 */
export interface InvoiceFiscalMeta {
  /** Operater koji je izdao račun (OibOper, HR-BT-5). */
  operator?: { name: string; oib: string | null };
  route?: FiscalRoute;
  cis?: { premises: string; device: string; seqMode: 'P' | 'N'; vatRegistered: boolean; demo: boolean };
  // stanje eRačuna kod posrednika
  provider?: string;
  env?: string;
  id?: string;
  status?: string;
  sentAt?: string;
  error?: string;
  /** Zadnje stanje kod posrednika (Osvježi status) kao tekst i vrijeme provjere. */
  statusText?: string;
  checkedAt?: string;
  /** Fiskalizirano bez slanja eRačuna (tip IR) ili prijavljeno u eIzvještavanje (tip I). */
  reportType?: 'IR' | 'I';
}

export const readMeta = (v: unknown): InvoiceFiscalMeta => (v && typeof v === 'object' && !Array.isArray(v) ? (v as InvoiceFiscalMeta) : {});

/**
 * Pri izdavanju (unutar transakcije, bez mrežnih poziva): odluka o putu,
 * provjera preduvjeta i izračun ZKI-ja. Sam poziv CIS-a/posrednika ide nakon
 * potvrde transakcije (`fiscalizeInvoice` / `sendEInvoice`).
 */
export async function fiscalAtIssue(
  tx: Tx,
  actor: { id: string; name: string },
  inv: { paymentMethod: PaymentMethod; company: Company; partner: Pick<Partner, 'country' | 'oib'>; seq: number; issuedAt: Date; total: number },
): Promise<Prisma.InvoiceUncheckedUpdateInput> {
  const c = inv.company;
  const route = fiscalRoute({ paymentMethod: inv.paymentMethod, company: c, partner: inv.partner });
  const op = await tx.user.findUnique({ where: { id: actor.id }, select: { name: true, oib: true } });
  // operater (OibOper, HR-BT-5): korisnik s upisanim OIB-om, inače zadani operater firme (Postavke → Firma)
  const userOib = op?.oib?.trim() || null;
  const companyOib = c.operatorOib?.trim() || null;
  const operator = userOib || !companyOib ? { name: op?.name ?? actor.name, oib: userOib } : { name: c.operatorName?.trim() || op?.name || actor.name, oib: companyOib };
  const meta: InvoiceFiscalMeta = { operator, route };

  if (route === 'NONE') return { eInvoice: meta as Prisma.InputJsonValue };
  if (route === 'EINVOICE') {
    return { eInvoice: { ...meta, provider: c.eInvoiceProvider, env: c.fiscalEnv, status: 'PENDING' } as Prisma.InputJsonValue, fiscalStatus: 'PENDING' };
  }

  const cert = companyCert(c);
  const missing = missingForCis({ companyOib: c.oib, operatorOib: operator.oib, premises: c.invoicePremises, device: c.invoiceDevice, hasCert: !!cert, env: c.fiscalEnv });
  if (missing.length) throw new DomainError(`Račun se mora fiskalizirati, a nedostaje: ${missing.join(', ')}.`);
  const demo = !cert;
  const key = cert?.privateKeyPem ?? demoKey().privateKeyPem;
  const zki = computeZki(
    key,
    zkiInput({ oib: c.oib!, issuedAt: inv.issuedAt, seq: inv.seq, premises: c.invoicePremises, device: c.invoiceDevice, total: inv.total }),
  );
  meta.cis = {
    premises: c.invoicePremises,
    device: c.invoiceDevice,
    seqMode: c.fiscalSequenceMode === 'N' ? 'N' : 'P',
    vatRegistered: c.vatRegistered,
    demo,
  };
  return { eInvoice: meta as Prisma.InputJsonValue, zki, fiscalStatus: 'PENDING' };
}
