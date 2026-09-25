import 'server-only';
import type { Tx } from '../db';
import { assert } from '../errors';
import type { Actor } from './items';
import { createContract } from './rentals';
import { CONTRACT_FROM_INVOICE } from './invoices';
import { addDays, addMonths } from '@/domain/dates';
import type { BillingCode } from '@/domain/billing';

/**
 * Račun za najam iz Prodaje: odabir postojećeg ugovora klijenta ili „+ Novi
 * ugovor" s uvjetima s računa (naplata, početak, trajanje, sezona). Uređaji se
 * vežu uz ugovor tek pri izdavanju računa (`issueInvoice` → stavke najma).
 */
export interface InvoiceRentTerms {
  startDate: string;
  billing: BillingCode;
  /** Trajanje u mjesecima (prazno = neodređeno). */
  months: number | null;
  seasonFrom: number | null;
  seasonTo: number | null;
}

/** Postojeći ugovor za račun: firma, isti klijent i ugovor na koji se smiju dodavati uređaji. */
export async function checkInvoiceContract(tx: Tx, actor: Actor, contractId: string, partnerId: string) {
  const c = await tx.contract.findFirst({ where: { id: contractId, companyId: actor.companyId }, select: { id: true, number: true, partnerId: true, status: true } });
  assert(c, 'Ugovor ne postoji.');
  assert(c.partnerId === partnerId, `Ugovor ${c.number} pripada drugom klijentu.`);
  assert(c.status === 'ACTIVE' || c.status === 'PAUSED', `Ugovor ${c.number} je raskinut ili istekao — odaberite drugi ili „+ Novi ugovor".`);
  return c;
}

/** Novi ugovor otvoren iz računa (uvjeti s računa); uređaje dodaje izdavanje računa. */
export async function openInvoiceContract(tx: Tx, actor: Actor, partnerId: string, t: InvoiceRentTerms) {
  assert(!t.months || (t.months > 0 && t.months <= 240), 'Trajanje ugovora mora biti između 1 i 240 mjeseci.');
  const partner = await tx.partner.findFirst({ where: { id: partnerId, companyId: actor.companyId }, select: { name: true } });
  assert(partner, 'Kupac ne postoji.');
  return createContract(tx, actor, {
    partnerId,
    startDate: t.startDate,
    endDate: t.months ? addDays(addMonths(t.startDate, t.months), -1) : null,
    firstBillingDate: null,
    billingDay: null,
    billing: t.billing,
    billingMode: 'IN_ADVANCE',
    seasonFrom: t.seasonFrom,
    seasonTo: t.seasonTo,
    note: `${CONTRACT_FROM_INVOICE} za ${partner.name}`,
  });
}
