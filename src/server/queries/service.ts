import 'server-only';
import type { Prisma, ServiceStatus } from '@prisma/client';
import { db } from '../db';
import { addDays, fromISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { LONG_SERVICE_DAYS, OPEN_SERVICE_STATUSES, SERVICE_STATUS } from '@/components/service/labels';

type Params = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const ci = (q: string) => ({ contains: q, mode: 'insensitive' as const });
const OPEN = OPEN_SERVICE_STATUSES as ServiceStatus[];

/**
 * Filtri popisa naloga. Zadano se prikazuju samo otvoreni (`scope` = open);
 * `scope=closed` zatvoreni, `scope=all` svi.
 */
export function serviceWhere(companyId: string, sp: Params): Prisma.ServiceOrderWhereInput {
  const q = str(sp.q);
  const status = str(sp.status);
  const scope = str(sp.scope) ?? 'open';
  const partnerId = str(sp.partner);
  const warranty = str(sp.warranty);
  const and: Prisma.ServiceOrderWhereInput[] = [];
  if (status && status in SERVICE_STATUS) and.push({ status: status as ServiceStatus });
  else if (scope === 'open') and.push({ status: { in: OPEN } });
  else if (scope === 'closed') and.push({ status: { notIn: OPEN } });
  if (partnerId) and.push({ partnerId });
  if (warranty === 'yes') and.push({ underWarranty: true });
  if (warranty === 'no') and.push({ underWarranty: false });
  if (str(sp.long) === '1') and.push({ status: { in: OPEN }, reportedAt: { lt: fromISO(addDays(today(), -LONG_SERVICE_DAYS)) } });
  if (q) {
    and.push({
      OR: [
        { number: ci(q) },
        { serial: ci(q) },
        { issue: ci(q) },
        { diagnosis: ci(q) },
        { partner: { name: ci(q) } },
        { item: { model: { OR: [{ name: ci(q) }, { brand: ci(q) }] } } },
      ],
    });
  }
  return { companyId, AND: and };
}

export async function listServiceOrders(companyId: string, sp: Params, pg: { skip: number; take: number }) {
  const where = serviceWhere(companyId, sp);
  const longAgo = fromISO(addDays(today(), -LONG_SERVICE_DAYS));
  const [rows, total, sum, open, long, noWarranty] = await Promise.all([
    db.serviceOrder.findMany({
      where,
      orderBy: [{ reportedAt: 'desc' }, { number: 'desc' }],
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true,
        number: true,
        serial: true,
        status: true,
        reportedAt: true,
        closedAt: true,
        issue: true,
        cost: true,
        underWarranty: true,
        item: { select: { id: true, model: { select: { brand: true, name: true } } } },
        partner: { select: { id: true, name: true } },
        replacement: { select: { id: true, serial: true } },
      },
    }),
    db.serviceOrder.count({ where }),
    db.serviceOrder.aggregate({ where, _sum: { cost: true } }),
    db.serviceOrder.count({ where: { AND: [where, { status: { in: OPEN } }] } }),
    db.serviceOrder.count({ where: { AND: [where, { status: { in: OPEN }, reportedAt: { lt: longAgo } }] } }),
    db.serviceOrder.count({ where: { AND: [where, { underWarranty: false }] } }),
  ]);
  return { rows, total, stats: { cost: num(sum._sum.cost), open, long, noWarranty } };
}

export async function getServiceOrder(companyId: string, id: string) {
  return db.serviceOrder.findFirst({
    where: { id, companyId },
    include: {
      partner: true,
      invoice: { select: { id: true, number: true, date: true } },
      replacement: { select: { id: true, serial: true, model: { select: { brand: true, name: true } } } },
      item: {
        select: {
          id: true,
          serial: true,
          state: true,
          partnerId: true,
          invoiceId: true,
          warehouseId: true,
          issueDate: true,
          warrantyStart: true,
          warrantyMonths: true,
          supplier: { select: { name: true } },
          status: { select: { name: true, color: true } },
          warehouse: { select: { name: true } },
          model: { select: { brand: true, name: true, code: true } },
          contractItem: { select: { id: true, contractId: true, monthly: true, plan: true, skipped: true, paused: true, status: true, contract: { select: { number: true } } } },
        },
      },
    },
  });
}

/** Pretraga uređaja po serijskom broju (za odabir na nalogu). */
export async function searchItems(companyId: string, q: string, opts: { stockOnly?: boolean; excludeId?: string | null } = {}) {
  const t = q.trim();
  return db.item.findMany({
    where: {
      companyId,
      ...(opts.stockOnly ? { state: 'IN_STOCK' } : {}),
      ...(opts.excludeId ? { id: { not: opts.excludeId } } : {}),
      ...(t ? { OR: [{ serial: ci(t) }, { model: { name: ci(t) } }, { partner: { name: ci(t) } }] } : {}),
    },
    orderBy: t ? { serial: 'asc' } : { updatedAt: 'desc' },
    take: 30,
    select: {
      id: true,
      serial: true,
      state: true,
      model: { select: { brand: true, name: true } },
      partner: { select: { name: true } },
      warehouse: { select: { name: true } },
      status: { select: { name: true } },
    },
  });
}

/** Podaci o uređaju za obrazac novog naloga (jamstvo, klijent, otvoreni nalog). */
export async function itemForService(companyId: string, id: string) {
  const item = await db.item.findFirst({
    where: { id, companyId },
    select: {
      id: true,
      serial: true,
      state: true,
      issueDate: true,
      warrantyStart: true,
      warrantyMonths: true,
      model: { select: { brand: true, name: true, warrantyMonths: true } },
      partner: { select: { id: true, name: true } },
      status: { select: { name: true } },
      contractItem: { select: { contract: { select: { number: true } } } },
      serviceOrders: { where: { status: { in: OPEN } }, select: { id: true, number: true }, take: 1 },
    },
  });
  return item;
}

/** Klijenti koji imaju servisne naloge — za filtar popisa. */
export async function servicePartners(companyId: string) {
  const rows = await db.serviceOrder.findMany({
    where: { companyId, partnerId: { not: null } },
    distinct: ['partnerId'],
    select: { partner: { select: { id: true, name: true } } },
  });
  return rows.map((r) => r.partner!).sort((a, b) => a.name.localeCompare(b.name, 'hr'));
}
