import { getUser } from '@/server/auth';
import { currentBuildId, onlineUsers } from '@/server/queries/presence';

export const dynamic = 'force-dynamic';

/**
 * Stanje za zaglavlje (poziva se svakih nekoliko minuta): oznaka izdanja
 * aplikacije (obavijest o novoj verziji) i tko je trenutno prijavljen u firmi.
 * Bez prijave vraća samo izdanje.
 */
export async function GET() {
  const [user, buildId] = await Promise.all([getUser(), currentBuildId()]);
  const online = user && !user.mdmOrgId ? await onlineUsers(user.companyId) : [];
  return Response.json({ buildId, online }, { headers: { 'Cache-Control': 'no-store' } });
}
