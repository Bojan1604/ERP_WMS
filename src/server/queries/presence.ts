import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db';

/** Korisnik je „prijavljen" ako je bio aktivan u zadnjih 5 minuta (User.lastSeenAt). */
export const ONLINE_MS = 5 * 60_000;

/** Tko je trenutno u programu (ova firma, bez vanjskih korisnika MDM-a). Indeks (companyId, lastSeenAt). */
export async function onlineUsers(companyId: string) {
  const rows = await db.user.findMany({
    where: { companyId, active: true, role: { notIn: ['DISTRIBUTOR', 'CLIENT'] }, lastSeenAt: { gt: new Date(Date.now() - ONLINE_MS) } },
    orderBy: { lastSeenAt: 'desc' },
    take: 50,
    select: { id: true, name: true, lastSeenAt: true },
  });
  return rows.map((u) => ({ id: u.id, name: u.name, lastSeenAt: u.lastSeenAt!.toISOString() }));
}

let buildId: string | null = null;

/**
 * Oznaka izdanja aplikacije (.next/BUILD_ID, u razvoju „dev"). Klijent je
 * uspoređuje s onom s kojom je učitan i nudi „Osvježi" kad se promijeni.
 */
export async function currentBuildId(): Promise<string> {
  if (buildId) return buildId;
  try {
    buildId = (await readFile(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')).trim() || 'dev';
  } catch {
    buildId = 'dev';
  }
  // u razvoju se izdanje mijenja pri svakoj promjeni — ne pamti se
  const id = buildId;
  if (process.env.NODE_ENV !== 'production') buildId = null;
  return id;
}
