import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { can, canSeeCost, type PermissionMap } from '@/domain/permissions';
import { addDays, daysBetween, fromISO, today, toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { pendingRentSummary } from './pending-rent';
import { returnSummary } from './warehouse';
import { expensesByMonth } from './reports/costs';
import { readReceivePayload } from '@/domain/receive-request';
import { portalNewCount } from '../portal/count';

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
  const costs = canSeeCost(perms);
  const expensesOn = can(perms, 'expenses');
  const settings = can(perms, 'settings');
  const whEdit = can(perms, 'warehouse', 'edit');
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
    serviceOld, byStatus, stale, serviceOpen, returns, receive, expensesYear, backup, portal,
  ] = await Promise.all([
    skip(money, () => db.invoice.aggregate({ where: revenueWhere(companyId, year), _sum: { netTotal: true } })),
    skip(money, () => db.invoice.aggregate({ where: { ...revenueWhere(companyId, year), type: 'SALE' }, _sum: { costTotal: true } })),
    skip(money, () =>
      db.$queryRaw<Array<{ m: number; type: string; net: Prisma.Decimal; cost: Prisma.Decimal }>>`
        SELECT EXTRACT(MONTH FROM i."date")::int AS m, i."type"::text AS type, SUM(i."netTotal") AS net,
               SUM(CASE WHEN i."type" = 'SALE' THEN i."costTotal" ELSE 0 END) AS cost
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
    skip(rentals, () => pendingRentSummary(companyId)),
    skip(wh, () => db.item.count({ where: { companyId, state: 'RESERVED' } })),
    skip(wh, () => db.item.count({ where: { companyId, state: 'RETURNING' } })),
    skip(wh, () => db.approvalRequest.count({ where: { companyId, status: 'PENDING', kind: 'STATUS_CHANGE' } })),
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
    // uređaji po statusu (pita) — bez otpisanih
    skip(wh, () =>
      db.$queryRaw<Array<{ id: string; name: string; cnt: number }>>`
        SELECT s.id, s.name, COUNT(i.id)::int AS cnt FROM "Item" i JOIN "ItemStatus" s ON s.id = i."statusId"
        WHERE i."companyId" = ${companyId} AND i."state" <> 'WRITTEN_OFF' GROUP BY s.id, s.name, s."sort" ORDER BY s."sort", s.name`,
    ),
    // zaliha starija od godine dana (od zaprimanja)
    skip(wh, () =>
      db.$queryRaw<Array<{ id: string; serial: string; model: string; since: Date; cost: Prisma.Decimal; total: number; value: Prisma.Decimal }>>`
        SELECT i.id, i.serial, concat_ws(' ', m.brand, m.name) AS model, COALESCE(i."importDate", i."createdAt"::date) AS since, i."cost",
               COUNT(*) OVER ()::int AS total, SUM(i."cost") OVER () AS value
        FROM "Item" i JOIN "DeviceModel" m ON m.id = i."modelId"
        WHERE i."companyId" = ${companyId} AND i."state" = 'IN_STOCK' AND COALESCE(i."importDate", i."createdAt"::date) < ${fromISO(addDays(now, -365))}::date
        ORDER BY since, i.serial LIMIT 6`,
    ),
    skip(service, () => db.serviceOrder.count({ where: { companyId, status: { in: [...OPEN_SERVICE] } } })),
    skip(wh || rentals, () => returnSummary(companyId)),
    skip(whEdit, () => db.approvalRequest.findMany({ where: { companyId, status: 'PENDING', kind: 'RECEIVE' }, orderBy: { createdAt: 'asc' }, take: 20, select: { id: true, requestedBy: true, payload: true } })),
    // troškovi uključuju nabavu robe (nabavne cijene) — samo uz pravo na troškove I na nabavne cijene
    skip(expensesOn && costs, () => expensesByMonth(companyId, year).then((e) => e.total.reduce((a, b) => a + b, 0))),
    skip(settings, () => db.company.findUniqueOrThrow({ where: { id: companyId }, select: { backupReminderDays: true, lastBackupAt: true, autoBackup: true } })),
    // nove prijave kvara s portala za klijente (servisni nalozi izvora PORTAL u statusu „Prijavljeno")
    skip(service, () =>
      Promise.all([
        portalNewCount(companyId),
        db.serviceOrder.findMany({
          where: { companyId, source: 'PORTAL', status: 'REPORTED' },
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { id: true, serial: true, partner: { select: { name: true } } },
        }),
      ]),
    ),
  ]);

  const months = Array.from({ length: 12 }, () => ({ SALE: 0, RENT: 0, SERVICE: 0, cost: 0 }));
  for (const r of byMonth ?? []) {
    months[r.m - 1][r.type as 'SALE' | 'RENT' | 'SERVICE'] += num(r.net);
    months[r.m - 1].cost += num(r.cost);
  }
  const receiveCodes = (receive ?? []).reduce((a, r) => a + readReceivePayload(r.payload).serials.length, 0);
  const backupDue =
    backup && backup.backupReminderDays > 0 && (!backup.lastBackupAt || daysBetween(toISO(backup.lastBackupAt), now) >= backup.backupReminderDays)
      ? { last: backup.lastBackupAt ? toISO(backup.lastBackupAt) : null, days: backup.lastBackupAt ? daysBetween(toISO(backup.lastBackupAt), now) : null }
      : null;

  const revenueNet = num(revenue?._sum.netTotal);
  return {
    year,
    today: now,
    access: { sales, money, rentals, wh, service, reports: can(perms, 'reports'), costs, settings },
    kpi: {
      revenue: money ? revenueNet : null,
      grossProfit: money && costs ? revenueNet - num(saleCost?._sum.costTotal) : null,
      expenses: expensesYear !== null ? { amount: expensesYear, net: money ? revenueNet - expensesYear : null } : null,
      serviceOpen,
      receivables: receivables ? { amount: num(receivables._sum.openAmount), count: receivables._count } : null,
      overdue: overdue ? { amount: num(overdue._sum.openAmount), count: overdue._count } : null,
      // vrijednost zalihe je nabavna — samo uz pravo na nabavne cijene
      stock: stock ? { value: costs ? num(stock._sum.cost) : null, count: stock._count } : null,
      rent: rentMonthly ? { monthly: num(rentMonthly._sum.monthly), contracts: activeContracts ?? 0 } : null,
    },
    // bruto dobit kao KPI i izvještaj „Profit po mjesecima": sav prihod − nabavna vrijednost prodanog
    months: money ? months.map((m) => ({ ...m, profit: costs ? m.SALE + m.RENT + m.SERVICE - m.cost : null })) : null,
    byStatus,
    stale: stale ? { count: stale[0]?.total ?? 0, value: costs ? num(stale[0]?.value) : null, rows: stale.map((r) => ({ id: r.id, serial: r.serial, model: r.model, since: toISO(r.since), cost: costs ? num(r.cost) : null })) } : null,
    // povrat s terena: broj, razlozi i ugovori
    returns,
    receive: receive ? { count: receive.length, codes: receiveCodes, by: [...new Set(receive.map((r) => r.requestedBy))] } : null,
    backupDue,
    portal: portal ? { count: portal[0], rows: portal[1].map((r) => ({ id: r.id, serial: r.serial, partner: r.partner?.name ?? null })) } : null,
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
