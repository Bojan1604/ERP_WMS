import 'server-only';
import type { OrderStatus, Prisma } from '@prisma/client';
import { db } from '../db';
import { num, r2 } from '@/domain/money';
import { fromISO } from '@/domain/dates';

type Params = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const yearOf = (v: string | string[] | undefined) => {
  const y = Number(str(v));
  return Number.isInteger(y) && y > 1900 && y < 3000 ? y : null;
};
const yearRange = (y: number) => ({ gte: fromISO(`${y}-01-01`), lt: fromISO(`${y + 1}-01-01`) });
const ci = (q: string) => ({ contains: q, mode: 'insensitive' as const });

const ORDER_STATUSES: OrderStatus[] = ['DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'];

// ---------------------------------------------------------------- narudžbenice

export async function listOrders(companyId: string, sp: Params, pg: { skip: number; take: number }) {
  const q = str(sp.q);
  const status = str(sp.status);
  const supplierId = str(sp.supplier);
  const year = yearOf(sp.year);
  const where: Prisma.PurchaseOrderWhereInput = {
    companyId,
    ...(status === 'open' ? { status: { in: ['ORDERED', 'PARTIAL'] } } : status && (ORDER_STATUSES as string[]).includes(status) ? { status: status as OrderStatus } : {}),
    ...(supplierId ? { supplierId } : {}),
    ...(year ? { date: yearRange(year) } : {}),
    ...(q ? { OR: [{ number: ci(q) }, { note: ci(q) }, { supplier: { name: ci(q) } }, { lines: { some: { model: { OR: [{ name: ci(q) }, { brand: ci(q) }] } } } }] } : {}),
  };
  const [rows, total, sum] = await Promise.all([
    db.purchaseOrder.findMany({
      where,
      orderBy: [{ date: 'desc' }, { number: 'desc' }],
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true,
        number: true,
        date: true,
        expectedDate: true,
        status: true,
        total: true,
        supplier: { select: { id: true, name: true } },
        lines: { select: { qty: true, received: true } },
      },
    }),
    db.purchaseOrder.count({ where }),
    db.purchaseOrder.aggregate({ where, _sum: { total: true } }),
  ]);
  return { rows, total, sum: num(sum._sum.total) };
}

export async function orderYears(companyId: string) {
  const rows = await db.$queryRaw<{ y: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM "date")::int AS y FROM "PurchaseOrder" WHERE "companyId" = ${companyId} ORDER BY y DESC`;
  return rows.map((r) => r.y);
}

export async function getOrder(companyId: string, id: string) {
  return db.purchaseOrder.findFirst({
    where: { id, companyId },
    include: {
      supplier: true,
      lines: { orderBy: { id: 'asc' }, include: { model: { select: { id: true, brand: true, name: true, code: true } } } },
      receipts: {
        orderBy: { date: 'asc' },
        select: { id: true, number: true, date: true, status: true, total: true, warehouse: { select: { name: true } }, _count: { select: { items: true } } },
      },
    },
  });
}

/**
 * Modeli ispod minimalne zalihe: stanje na skladištu jednim groupBy upitom,
 * uz količinu koja je već naručena, a još nije stigla.
 */
export async function lowStock(companyId: string) {
  const models = await db.deviceModel.findMany({
    where: { companyId, active: true, minStock: { gt: 0 } },
    select: { id: true, brand: true, name: true, minStock: true },
    orderBy: [{ brand: 'asc' }, { name: 'asc' }],
  });
  if (!models.length) return [];
  const ids = models.map((m) => m.id);
  const [stock, ordered, lastCost] = await Promise.all([
    db.item.groupBy({ by: ['modelId'], where: { companyId, state: 'IN_STOCK', modelId: { in: ids } }, _count: { _all: true } }),
    db.purchaseOrderLine.groupBy({
      by: ['modelId'],
      where: { modelId: { in: ids }, order: { companyId, status: { in: ['ORDERED', 'PARTIAL'] } } },
      _sum: { qty: true, received: true },
    }),
    // zadnja nabavna cijena po modelu — za prijedlog narudžbenice
    db.$queryRaw<{ modelId: string; cost: Prisma.Decimal }[]>`
      SELECT DISTINCT ON ("modelId") "modelId", "cost" FROM "Item"
      WHERE "companyId" = ${companyId} AND "modelId" = ANY(${ids}) AND "cost" > 0
      ORDER BY "modelId", "createdAt" DESC`,
  ]);
  const stockBy = new Map(stock.map((s) => [s.modelId, s._count._all]));
  const orderedBy = new Map(ordered.map((o) => [o.modelId, (o._sum.qty ?? 0) - (o._sum.received ?? 0)]));
  const costBy = new Map(lastCost.map((c) => [c.modelId, num(c.cost)]));
  return models
    .map((m) => {
      const inStock = stockBy.get(m.id) ?? 0;
      const onOrder = Math.max(0, orderedBy.get(m.id) ?? 0);
      return { ...m, inStock, onOrder, missing: Math.max(0, m.minStock - inStock - onOrder), lastCost: costBy.get(m.id) ?? 0 };
    })
    .filter((m) => m.inStock < m.minStock);
}

// ---------------------------------------------------------------- primke

export async function listReceipts(companyId: string, sp: Params, pg: { skip: number; take: number }) {
  const q = str(sp.q);
  const supplierId = str(sp.supplier);
  const warehouseId = str(sp.warehouse);
  const status = str(sp.status);
  const year = yearOf(sp.year);
  const where: Prisma.GoodsReceiptWhereInput = {
    companyId,
    ...(supplierId ? { supplierId } : {}),
    ...(warehouseId ? { warehouseId } : {}),
    ...(status === 'POSTED' || status === 'CANCELLED' ? { status } : {}),
    ...(year ? { date: yearRange(year) } : {}),
    ...(q
      ? {
          OR: [
            { number: ci(q) },
            { supplierDocNumber: ci(q) },
            { supplier: { name: ci(q) } },
            { order: { number: ci(q) } },
            { items: { some: { serial: ci(q) } } },
          ],
        }
      : {}),
  };
  const [rows, total, sum] = await Promise.all([
    db.goodsReceipt.findMany({
      where,
      orderBy: [{ date: 'desc' }, { number: 'desc' }],
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true,
        number: true,
        date: true,
        status: true,
        total: true,
        supplierDocNumber: true,
        supplier: { select: { id: true, name: true } },
        warehouse: { select: { name: true } },
        order: { select: { id: true, number: true } },
        _count: { select: { items: true } },
      },
    }),
    db.goodsReceipt.count({ where }),
    db.goodsReceipt.aggregate({ where: { ...where, status: 'POSTED' }, _sum: { total: true } }),
  ]);
  return { rows, total, sum: num(sum._sum.total) };
}

export async function receiptYears(companyId: string) {
  const rows = await db.$queryRaw<{ y: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM "date")::int AS y FROM "GoodsReceipt" WHERE "companyId" = ${companyId} ORDER BY y DESC`;
  return rows.map((r) => r.y);
}

export async function getReceipt(companyId: string, id: string) {
  const receipt = await db.goodsReceipt.findFirst({
    where: { id, companyId },
    include: {
      supplier: true,
      warehouse: { select: { id: true, name: true } },
      order: { select: { id: true, number: true } },
      expense: { select: { id: true, netAmount: true, vatAmount: true, paid: true } },
    },
  });
  if (!receipt) return null;
  const items = await db.item.findMany({
    where: { receiptId: id, companyId },
    orderBy: [{ modelId: 'asc' }, { serial: 'asc' }],
    select: {
      id: true,
      serial: true,
      cost: true,
      state: true,
      modelId: true,
      model: { select: { brand: true, name: true, code: true } },
      contractItem: { select: { id: true } },
      invoiceLines: { select: { id: true }, take: 1 },
    },
  });
  // stavke primke: uređaji grupirani po modelu i nabavnoj cijeni
  const groups = new Map<string, { model: string; code: string | null; unitCost: number; serials: string[]; ids: string[] }>();
  for (const i of items) {
    const key = `${i.modelId}|${num(i.cost)}`;
    const g = groups.get(key) ?? { model: [i.model.brand, i.model.name].filter(Boolean).join(' '), code: i.model.code, unitCost: num(i.cost), serials: [], ids: [] };
    g.serials.push(i.serial);
    g.ids.push(i.id);
    groups.set(key, g);
  }
  const blocked = items.filter((i) => i.state !== 'IN_STOCK' || i.contractItem || i.invoiceLines.length).map((i) => i.serial);
  return {
    receipt,
    groups: [...groups.values()].map((g) => ({ ...g, qty: g.serials.length, total: r2(g.serials.length * g.unitCost) })),
    count: items.length,
    blocked,
  };
}

// ---------------------------------------------------------------- ulazni računi

/** Odbijeni ulazni račun nije obveza, trošak ni stavka izvještaja. */
export const NOT_REJECTED: Prisma.SupplierInvoiceWhereInput = { status: { not: 'REJECTED' } };

/** Filtar statusa na popisu: zaprimljen / prihvaćen (neplaćen) / odbijen / plaćen. */
const SUPPLIER_INVOICE_STATUS_WHERE: Record<string, Prisma.SupplierInvoiceWhereInput> = {
  received: { status: 'RECEIVED', paidDate: null },
  accepted: { status: 'ACCEPTED', paidDate: null },
  rejected: { status: 'REJECTED' },
  paid: { status: { not: 'REJECTED' }, paidDate: { not: null } },
};

export async function listSupplierInvoices(companyId: string, sp: Params, pg: { skip: number; take: number }) {
  const q = str(sp.q);
  const supplierId = str(sp.supplier);
  const paid = str(sp.paid);
  const status = str(sp.status);
  const source = str(sp.source);
  const year = yearOf(sp.year);
  const where: Prisma.SupplierInvoiceWhereInput = {
    companyId,
    ...(supplierId ? { supplierId } : {}),
    ...(paid === 'yes' ? { paidDate: { not: null } } : paid === 'no' ? { paidDate: null } : {}),
    ...(status ? SUPPLIER_INVOICE_STATUS_WHERE[status] ?? {} : {}),
    ...(source === 'einvoice' ? { source: 'EINVOICE' as const } : source === 'manual' ? { source: 'MANUAL' as const } : {}),
    ...(year ? { issueDate: yearRange(year) } : {}),
    ...(q ? { OR: [{ number: ci(q) }, { internalNo: ci(q) }, { note: ci(q) }, { category: ci(q) }, { supplier: { name: ci(q) } }] } : {}),
  };
  const [rows, total, sums] = await Promise.all([
    db.supplierInvoice.findMany({
      where,
      orderBy: [{ issueDate: 'desc' }, { internalNo: 'desc' }],
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true,
        internalNo: true,
        number: true,
        issueDate: true,
        dueDate: true,
        netAmount: true,
        vatAmount: true,
        total: true,
        paidDate: true,
        category: true,
        source: true,
        status: true,
        supplier: { select: { id: true, name: true } },
        expense: { select: { id: true } },
      },
    }),
    db.supplierInvoice.count({ where }),
    // odbijeni računi nisu obveza ni trošak — ne ulaze u zbrojeve (osim kad se gledaju samo odbijeni)
    db.supplierInvoice.aggregate({ where: status === 'rejected' ? where : { AND: [where, NOT_REJECTED] }, _sum: { netAmount: true, vatAmount: true, total: true } }),
  ]);
  const unpaid = await db.supplierInvoice.aggregate({ where: { AND: [where, NOT_REJECTED, { paidDate: null }] }, _sum: { total: true } });
  return {
    rows,
    total,
    sums: { net: num(sums._sum.netAmount), vat: num(sums._sum.vatAmount), total: num(sums._sum.total), unpaid: num(unpaid._sum.total) },
  };
}

export async function supplierInvoiceYears(companyId: string) {
  const rows = await db.$queryRaw<{ y: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM "issueDate")::int AS y FROM "SupplierInvoice" WHERE "companyId" = ${companyId} ORDER BY y DESC`;
  return rows.map((r) => r.y);
}

export async function getSupplierInvoice(companyId: string, id: string) {
  const si = await db.supplierInvoice.findFirst({
    where: { id, companyId },
    include: { supplier: { select: { id: true, name: true, country: true, oib: true } }, expense: { select: { id: true } } },
  });
  if (!si) return null;
  const attachments = await db.attachment.findMany({
    where: { companyId, entity: 'supplierInvoice', entityId: id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, fileName: true, mime: true, size: true },
  });
  return { ...si, attachments };
}

/** Dobavljači za odabir: partneri označeni kao dobavljači (+ trenutni, ako to više nije). */
export async function supplierOptions(companyId: string, includeId?: string | null) {
  return db.partner.findMany({
    where: { companyId, OR: [{ isSupplier: true }, ...(includeId ? [{ id: includeId }] : [])] },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, city: true, country: true },
  });
}

/** Zadnja nabavna cijena po modelu (prijedlog cijene na narudžbenici). */
export async function lastCosts(companyId: string) {
  const rows = await db.$queryRaw<{ modelId: string; cost: Prisma.Decimal }[]>`
    SELECT DISTINCT ON ("modelId") "modelId", "cost" FROM "Item"
    WHERE "companyId" = ${companyId} AND "cost" > 0
    ORDER BY "modelId", "createdAt" DESC`;
  return new Map(rows.map((r) => [r.modelId, num(r.cost)]));
}
