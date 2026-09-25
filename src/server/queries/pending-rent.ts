import 'server-only';
import { unstable_cache } from 'next/cache';
import { db } from '../db';
import { pendingForCompany } from '../services/rentals';
import { today } from '@/domain/dates';
import { r2 } from '@/domain/money';

/** Oznaka keša broja rata firme — `revalidateTag` nakon svake uspješne akcije (server/action.ts). */
export const pendingRentTag = (companyId: string) => `pending-rent:${companyId}`;

async function compute(companyId: string) {
  const rows = await pendingForCompany(db, companyId);
  return { count: rows.length, amount: r2(rows.reduce((a, x) => a + x.amount, 0)) };
}

/**
 * Broj i iznos rata najma za izdati (nadzorna ploča, popis računa). Izračun prolazi kroz sve
 * aktivne ugovore (~0,4 s na velikoj bazi), pa se kešira po firmi i danu: poništava ga svaka
 * akcija u firmi (izdavanje, ugovor, povrat…), a najkasnije za 5 min (automatsko izdavanje).
 * Izvan Next poslužitelja (testovi, skripte) računa se izravno.
 */
export async function pendingRentSummary(companyId: string) {
  const cached = unstable_cache(() => compute(companyId), ['pending-rent', companyId, today()], { revalidate: 300, tags: [pendingRentTag(companyId)] });
  try {
    return await cached();
  } catch (e) {
    if (e instanceof Error && e.message.includes('incrementalCache missing')) return compute(companyId);
    throw e;
  }
}
