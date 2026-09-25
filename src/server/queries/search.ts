import 'server-only';
import { db } from '../db';
import { can, type PermissionMap } from '@/domain/permissions';
import { escapeLike } from '@/lib/like';

const LIMIT = 10;

/**
 * Globalna pretraga iz gornje trake: do 10 pogodaka po vrsti, samo u
 * modulima za koje korisnik ima pravo. Sve se traži u bazi (indeksi po firmi).
 */
export async function globalSearch(companyId: string, perms: PermissionMap, raw: string) {
  const q = raw.trim().slice(0, 100);
  const ci = { contains: escapeLike(q), mode: 'insensitive' as const };
  const on = <T,>(ok: boolean, fn: () => Promise<T[]>) => (ok ? fn() : Promise.resolve(null));

  const [exact, devices, invoices, partners, contracts, quotes, services] = await Promise.all([
    on(can(perms, 'warehouse'), () => db.item.findMany({ where: { companyId, serial: { equals: q, mode: 'insensitive' } }, select: { id: true }, take: 2 })),
    on(can(perms, 'warehouse'), () =>
      db.item.findMany({
        where: { companyId, serial: ci },
        orderBy: { serial: 'asc' },
        take: LIMIT,
        select: { id: true, serial: true, dupNote: true, model: { select: { brand: true, name: true } }, status: { select: { name: true, color: true } }, partner: { select: { name: true } } },
      }),
    ),
    on(can(perms, 'sales'), () =>
      db.invoice.findMany({
        where: { companyId, number: ci },
        orderBy: [{ date: 'desc' }],
        take: LIMIT,
        select: { id: true, number: true, date: true, kind: true, grandTotal: true, openAmount: true, partner: { select: { name: true } } },
      }),
    ),
    on(can(perms, 'partners'), () =>
      db.partner.findMany({
        where: { companyId, OR: [{ name: ci }, { oib: { startsWith: escapeLike(q) } }, { vatId: ci }] },
        orderBy: { name: 'asc' },
        take: LIMIT,
        select: { id: true, name: true, oib: true, city: true, excluded: true },
      }),
    ),
    on(can(perms, 'rentals'), () =>
      db.contract.findMany({
        where: { companyId, number: ci },
        orderBy: { startDate: 'desc' },
        take: LIMIT,
        select: { id: true, number: true, status: true, startDate: true, partner: { select: { name: true } } },
      }),
    ),
    on(can(perms, 'sales'), () =>
      db.quote.findMany({
        where: { companyId, number: ci },
        orderBy: { date: 'desc' },
        take: LIMIT,
        select: { id: true, number: true, date: true, status: true, grandTotal: true, partner: { select: { name: true } } },
      }),
    ),
    on(can(perms, 'service'), () =>
      db.serviceOrder.findMany({
        where: { companyId, OR: [{ number: ci }, { serial: ci }] },
        orderBy: { reportedAt: 'desc' },
        take: LIMIT,
        select: { id: true, number: true, serial: true, status: true, reportedAt: true, issue: true, partner: { select: { name: true } } },
      }),
    ),
  ]);

  return {
    q,
    /** Točno jedan uređaj s tim serijskim brojem → izravno na njega. */
    exactDeviceId: exact && exact.length === 1 ? exact[0].id : null,
    devices,
    invoices,
    partners,
    contracts,
    quotes,
    services,
  };
}
