import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { can, type PermissionMap } from '@/domain/permissions';
import { addDays, fromISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { pendingForCompany } from '../services/rentals';

const OPEN_SERVICE = ['REPORTED', 'RECEIVED', 'DIAGNOSIS', 'AT_SUPPLIER'] as const;

/** Uvjet za prihod: izdani računi, storna i odobrenja (negativni), bez isključenih partnera. */
export const revenueWhere = (companyId: string, year: number): Prisma.InvoiceWhereInput => ({
  companyId,
  year,
  status: 'ISSUED',
  kind: { in: ['INVOICE', 'STORNO', 'CREDIT_NOTE'] },
  // storno predujma nije umanjenje prihoda — predujam nikad nije bio prihod
  NOT: { kind: 'STORNO', refInvoice: { kind: 'ADVANCE' } },
  partner: { excluded: false },
});

/**
 * Sve brojke nadzorne ploče u jednom prolazu — upiti idu paralelno, zbrojevi
 * se računaju u bazi. Dijelovi za koje korisnik nema pravo se ne dohvaćaju.
 */
export async function dashboardData(companyId: string, perms: PermissionMap) {
  const year = Number(today().slice(0, 4));
  const now = today();
  const todayDate = fromISO(now);
  const sales = can(perms, 'sales');
  // prihod i dobit: izvještaji ili puno pravo na prodaju (pregled računa sam po sebi nije dovoljan)
  const money = can(perms, 'reports') || can(perms, 'sales', 'edit');
  const rentals = can(perms, 'rentals');
  const wh = can(perms, 'warehouse');
  const service = can(perms, 'service');
  const skip = <T,>(on: boolean, fn: () => Promise<T>): Promise<T | null> => (on ? fn() : Promise.resolve(null));

  const receivableWhere: Prisma.InvoiceWhereInput = { companyId, status: 'ISSUED', openAmount: { gt: 0 }, partner: { excluded: false } };
  // kao izvještaj „Starost potraživanja": dospijeće = COALESCE(dueDate, date)
  const overdueWhere: Prisma.InvoiceWhereInput = {
    ...receivableWhere,
    OR: [{ dueDate: { lt: todayDate } }, { dueDate: null, date: { lt: todayDate } }],
  };

  const [
    revenue, saleCost, byMonth, receivables, overdue, overdueTop,
    stock, rentMonthly, activeContracts, pending,
    reserved, returning, approvals, lowStock, warranties,
    serviceOld,
  ] = await Promise.all([
    skip(money, () => db.invoice.aggregate({ where: revenueWhere(companyId, year), _sum: { netTotal: true } })),
    skip(money, () => db.invoice.aggregate({ where: { ...revenueWhere(companyId, year), type: 'SALE' }, _sum: { costTotal: true } })),
    skip(money, () =>
      db.$queryRaw<Array<{ m: number; type: string; net: Prisma.Decimal }>>`
        SELECT EXTRACT(MONTH FROM i."date")::int AS m, i."type"::text AS type, SUM(i."netTotal") AS net
        FROM "Invoice" i JOIN "Partner" p ON p.id = i."partnerId"
        WHERE i."companyId" = ${companyId} AND i."year" = ${year} AND i."status" = 'ISSUED'
          AND i."kind" IN ('INVOICE','STORNO','CREDIT_NOTE') AND p."excluded" = false
          AND NOT (i."kind" = 'STORNO' AND EXISTS (SELECT 1 FROM "Invoice" r WHERE r.id = i."refInvoiceId" AND r."kind" = 'ADVANCE'))
        GROUP BY 1, 2`,
    ),
    skip(sales, () => db.invoice.aggregate({ where: receivableWhere, _sum: { openAmount: true }, _count: true })),
    skip(sales, () => db.invoice.aggregate({ where: overdueWhere, _sum: { openAmount: true }, _count: true })),
    skip(sales, () =>
      db.invoice.findMany({
        where: overdueWhere,
        orderBy: [{ dueDate: 'asc' }, { date: 'asc' }],
        take: 5,
        select: { id: true, number: true, dueDate: true, date: true, openAmount: true, partner: { select: { name: true } } },
      }),
    ),
    skip(wh, () => db.item.aggregate({ where: { companyId, state: 'IN_STOCK' }, _sum: { cost: true }, _count: true })),
    skip(rentals, () =>
      db.contractItem.aggregate({
        where: { contract: { companyId, status: 'ACTIVE', partner: { excluded: false } }, OR: [{ status: null }, { status: 'ACTIVE' }] },
        _sum: { monthly: true },
      }),
    ),
    skip(rentals, () => db.contract.count({ where: { companyId, status: 'ACTIVE', partner: { excluded: false } } })),
    skip(rentals, () => pendingForCompany(db, companyId).then((r) => ({ count: r.length, amount: r.reduce((a, x) => a + x.amount, 0) }))),
    skip(wh, () => db.item.count({ where: { companyId, state: 'RESERVED' } })),
    skip(wh, () => db.item.count({ where: { companyId, state: 'RETURNING' } })),
    skip(wh, () => db.approvalRequest.count({ where: { companyId, status: 'PENDING' } })),
    skip(wh, () =>
      db.$queryRaw<Array<{ id: string; brand: string | null; name: string; minStock: number; stock: number }>>`
        SELECT m.id, m.brand, m.name, m."minStock",
               (SELECT COUNT(*)::int FROM "Item" i WHERE i."modelId" = m.id AND i."state" = 'IN_STOCK') AS stock
        FROM "DeviceModel" m
        WHERE m."companyId" = ${companyId} AND m."active" = true AND m."minStock" > 0
          AND (SELECT COUNT(*) FROM "Item" i WHERE i."modelId" = m.id AND i."state" = 'IN_STOCK') < m."minStock"
        ORDER BY m.brand, m.name`,
    ),
    skip(wh, () =>
      db.$queryRaw<Array<{ id: string; serial: string; ends: Date; partner: string | null; model: string }>>`
        SELECT i.id, i.serial, (i."warrantyStart" + make_interval(months => i."warrantyMonths"))::date AS ends,
               p.name AS partner, concat_ws(' ', m.brand, m.name) AS model
        FROM "Item" i
        JOIN "DeviceModel" m ON m.id = i."modelId"
        LEFT JOIN "Partner" p ON p.id = i."partnerId"
        WHERE i."companyId" = ${companyId} AND i."state" = 'SOLD'
          AND i."warrantyStart" IS NOT NULL AND i."warrantyMonths" > 0
          AND (i."warrantyStart" + make_interval(months => i."warrantyMonths"))::date BETWEEN ${todayDate}::date AND ${fromISO(addDays(now, 30))}::date
          AND (p.id IS NULL OR p."excluded" = false)
        ORDER BY ends`,
    ),
    skip(service, () =>
      Promise.all([
        db.serviceOrder.count({ where: { companyId, status: { in: [...OPEN_SERVICE] }, reportedAt: { lt: fromISO(addDays(now, -14)) } } }),
        db.serviceOrder.findMany({
          where: { companyId, status: { in: [...OPEN_SERVICE] }, reportedAt: { lt: fromISO(addDays(now, -14)) } },
          orderBy: { reportedAt: 'asc' },
          take: 5,
          select: { id: true, number: true, serial: true, reportedAt: true, partner: { select: { name: true } } },
        }),
      ]),
    ),
  ]);

  const months = Array.from({ length: 12 }, () => ({ SALE: 0, RENT: 0, SERVICE: 0 }));
  for (const r of byMonth ?? []) months[r.m - 1][r.type as 'SALE' | 'RENT' | 'SERVICE'] += num(r.net);

  const revenueNet = num(revenue?._sum.netTotal);
  return {
    year,
    today: now,
    access: { sales, money, rentals, wh, service, reports: can(perms, 'reports') },
    kpi: {
      revenue: money ? revenueNet : null,
      grossProfit: money ? revenueNet - num(saleCost?._sum.costTotal) : null,
      receivables: receivables ? { amount: num(receivables._sum.openAmount), count: receivables._count } : null,
      overdue: overdue ? { amount: num(overdue._sum.openAmount), count: overdue._count } : null,
      stock: stock ? { value: num(stock._sum.cost), count: stock._count } : null,
      rent: rentMonthly ? { monthly: num(rentMonthly._sum.monthly), contracts: activeContracts ?? 0 } : null,
    },
    months: money ? months : null,
    pending,
    overdueTop: overdueTop?.map((i) => ({ id: i.id, number: i.number, partner: i.partner.name, dueDate: i.dueDate ?? i.date, open: num(i.openAmount) })) ?? null,
    reserved,
    returning,
    approvals,
    lowStock,
    warranties,
    serviceOld: serviceOld ? { count: serviceOld[0], rows: serviceOld[1] } : null,
  };
}
