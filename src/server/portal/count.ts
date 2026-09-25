import 'server-only';
import { db } from '../db';

/**
 * Broj novih prijava kvara s portala (izvor PORTAL, status „Prijavljeno") —
 * značka u izborniku Servis i brojač na nadzornoj ploči.
 * Indeks: ServiceOrder (companyId, source, status).
 */
export function portalNewCount(companyId: string): Promise<number> {
  return db.serviceOrder.count({ where: { companyId, source: 'PORTAL', status: 'REPORTED' } });
}
