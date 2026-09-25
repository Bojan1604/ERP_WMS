import 'server-only';
import { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { removeFile } from './storage';

/**
 * Brisanje svih MDM podataka firme (opasna zona „Obriši sve", brisanje firme):
 * organizacije, lokacije, uređaji (s naredbama, događajima i snimkama), profili,
 * aplikacije s verzijama, datoteke, ključevi za upis i vanjski korisnici MDM-a
 * (distributeri, klijenti). Redoslijed poštuje strane ključeve (verzija aplikacije
 * → datoteka je RESTRICT, nadređena organizacija je RESTRICT).
 *
 * Datoteke na disku se brišu tek nakon potvrde transakcije: vraća se popis ključeva
 * za `removeStoredFiles` — pri neuspjehu transakcije datoteke ostaju.
 */
export async function wipeMdmData(tx: Tx, companyId: string): Promise<{ counts: Record<string, number>; storageKeys: string[] }> {
  const files = await tx.mdmFile.findMany({ where: { companyId }, select: { storageKey: true } });
  const del = (table: string) => tx.$executeRaw`DELETE FROM ${Prisma.raw(`"${table}"`)} WHERE "companyId" = ${companyId}`;
  const counts: Record<string, number> = {};
  counts.MdmEnrollToken = await del('MdmEnrollToken');
  counts.MdmDevice = await del('MdmDevice'); // + MdmCommand, MdmEvent, MdmUpload (kaskadno)
  counts.MdmApp = await del('MdmApp'); // + MdmAppVersion
  counts.MdmFile = await del('MdmFile');
  counts.MdmProfile = await del('MdmProfile'); // MdmSite.profileId → NULL
  // vanjski korisnici MDM-a pripadaju organizacijama firme (sesije kaskadno)
  counts.MdmUser = (await tx.user.deleteMany({ where: { companyId, role: { in: ['DISTRIBUTOR', 'CLIENT'] } } })).count;
  await tx.$executeRaw`UPDATE "MdmOrg" SET "parentId" = NULL WHERE "companyId" = ${companyId} AND "parentId" IS NOT NULL`;
  counts.MdmOrg = await del('MdmOrg'); // + MdmSite
  return { counts, storageKeys: files.map((f) => f.storageKey) };
}

/** Brisanje datoteka s diska nakon potvrđenog brisanja zapisa; greška pojedine datoteke ne prekida ostale. */
export async function removeStoredFiles(keys: string[]): Promise<number> {
  let n = 0;
  for (const k of keys) {
    try {
      await removeFile(k);
      n++;
    } catch {
      /* neispravan ključ ili datoteka već ne postoji */
    }
  }
  return n;
}
