import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { num, r2 } from '@/domain/money';
import { escapeLike } from '@/lib/like';
import { deviceWarrantyEnd } from './service';

/** Uređaji „kod partnera" — otpisani se ne broje ni ne prikazuju (kao na portalu). */
const ACTIVE_DEVICE: Prisma.ItemWhereInput = { state: { not: 'WRITTEN_OFF' } };

export type PartnerParams = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v.trim() : '');

/** Uvjet popisa partnera iz filtara u URL-u. */
export function partnerWhere(companyId: string, params: PartnerParams): Prisma.PartnerWhereInput {
  const q = str(params.q);
  const type = str(params.tip);
  const where: Prisma.PartnerWhereInput = { companyId };
  if (q) {
    const lit = escapeLike(q);
    where.OR = [
      { name: { contains: lit, mode: 'insensitive' } },
      { oib: { startsWith: lit } },
      { vatId: { contains: lit, mode: 'insensitive' } },
      { city: { contains: lit, mode: 'insensitive' } },
      { email: { contains: lit, mode: 'insensitive' } },
    ];
  }
  if (type === 'kupci') where.isCustomer = true;
  if (type === 'dobavljaci') where.isSupplier = true;
  if (str(params.iskljuceni) === '1') where.excluded = true;
  return where;
}

export const partnerListSelect = {
  id: true, name: true, oib: true, city: true, country: true, email: true, phone: true,
  isCustomer: true, isSupplier: true, excluded: true, note: true,
} satisfies Prisma.PartnerSelect;

/**
 * Brojke uz partnere na stranici — po jedan groupBy za račune (broj, promet,
 * otvoreno), uređaje kod partnera i aktivne ugovore.
 */
export async function partnerStats(companyId: string, ids: string[]) {
  type S = { open: number; devices: number; contracts: number; invoices: number; turnover: number };
  if (!ids.length) return new Map<string, S>();
  const [inv, devices, contracts] = await Promise.all([
    db.invoice.groupBy({
      by: ['partnerId'],
      where: { companyId, partnerId: { in: ids }, status: 'ISSUED' },
      _sum: { openAmount: true, grandTotal: true },
      _count: { _all: true },
    }),
    db.item.groupBy({ by: ['partnerId'], where: { companyId, partnerId: { in: ids }, ...ACTIVE_DEVICE }, _count: { _all: true } }),
    db.contract.groupBy({ by: ['partnerId'], where: { companyId, partnerId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } }),
  ]);
  const out = new Map<string, S>(ids.map((id) => [id, { open: 0, devices: 0, contracts: 0, invoices: 0, turnover: 0 }]));
  for (const r of inv) {
    const s = out.get(r.partnerId)!;
    s.open = num(r._sum.openAmount);
    s.turnover = num(r._sum.grandTotal);
    s.invoices = r._count._all;
  }
  for (const r of devices) if (r.partnerId) out.get(r.partnerId)!.devices = r._count._all;
  for (const r of contracts) out.get(r.partnerId)!.contracts = r._count._all;
  return out;
}

/** Podnožje popisa partnera: promet i otvoreno za cijeli filtar (bez isključenih iz obračuna). */
export async function partnerTotals(companyId: string, params: PartnerParams) {
  const where = partnerWhere(companyId, params);
  const [sums, excluded] = await Promise.all([
    db.invoice.aggregate({
      where: { companyId, status: 'ISSUED', partner: { AND: [where, { excluded: false }] } },
      _sum: { grandTotal: true, openAmount: true },
    }),
    db.partner.count({ where: { AND: [where, { excluded: true }] } }),
  ]);
  return { turnover: num(sums._sum.grandTotal), open: num(sums._sum.openAmount), excluded };
}

export async function listPartners(companyId: string, params: PartnerParams, page: { skip: number; take: number }) {
  const where = partnerWhere(companyId, params);
  const [rows, total] = await Promise.all([
    db.partner.findMany({ where, orderBy: { name: 'asc' }, skip: page.skip, take: page.take, select: partnerListSelect }),
    db.partner.count({ where }),
  ]);
  const stats = await partnerStats(companyId, rows.map((r) => r.id));
  return { rows: rows.map((r) => ({ ...r, ...stats.get(r.id)! })), total };
}

export async function getPartner(companyId: string, id: string) {
  return db.partner.findFirst({ where: { id, companyId } });
}

/** Brojevi za kartice na stranici partnera. */
export async function partnerCounts(companyId: string, partnerId: string) {
  const [invoices, devices, contracts, prices, open] = await Promise.all([
    db.invoice.count({ where: { companyId, partnerId } }),
    db.item.count({ where: { companyId, partnerId, ...ACTIVE_DEVICE } }),
    db.contract.count({ where: { companyId, partnerId } }),
    db.priceAgreement.count({ where: { companyId, partnerId } }),
    db.invoice.aggregate({ where: { companyId, partnerId, status: 'ISSUED', openAmount: { gt: 0 } }, _sum: { openAmount: true }, _count: true }),
  ]);
  return { invoices, devices, contracts, prices, open: num(open._sum.openAmount), openCount: open._count };
}

export async function partnerInvoices(companyId: string, partnerId: string, page: { skip: number; take: number }) {
  const where: Prisma.InvoiceWhereInput = { companyId, partnerId };
  const [rows, total, sums] = await Promise.all([
    db.invoice.findMany({
      where,
      orderBy: [{ date: 'desc' }, { seq: 'desc' }],
      skip: page.skip,
      take: page.take,
      select: {
        id: true, number: true, status: true, kind: true, type: true, stornoed: true, date: true, dueDate: true,
        netTotal: true, grandTotal: true, paidTotal: true, openAmount: true, paidDate: true,
      },
    }),
    db.invoice.count({ where }),
    db.invoice.aggregate({ where: { ...where, status: 'ISSUED' }, _sum: { netTotal: true, grandTotal: true, openAmount: true } }),
  ]);
  return { rows, total, sums: { net: num(sums._sum.netTotal), gross: num(sums._sum.grandTotal), open: num(sums._sum.openAmount) } };
}

export const partnerDeviceSelect = {
  id: true, serial: true, state: true, issueDate: true, warrantyStart: true, warrantyMonths: true, salePrice: true,
  model: { select: { brand: true, name: true, warrantyMonths: true } },
  status: { select: { name: true, color: true } },
  contractItem: { select: { contract: { select: { id: true, number: true } } } },
} satisfies Prisma.ItemSelect;

export async function partnerDevices(companyId: string, partnerId: string, page?: { skip: number; take: number }) {
  const where: Prisma.ItemWhereInput = { companyId, partnerId, ...ACTIVE_DEVICE };
  const [rows, total] = await Promise.all([
    db.item.findMany({ where, orderBy: [{ model: { name: 'asc' } }, { serial: 'asc' }], select: partnerDeviceSelect, ...(page ? { skip: page.skip, take: page.take } : {}) }),
    db.item.count({ where }),
  ]);
  // kraj jamstva isto kao na portalu: početak jamstva ili izdavanja + trajanje uređaja ili modela
  return { rows: rows.map((r) => ({ ...r, warrantyEnd: deviceWarrantyEnd(r) })), total };
}

export async function partnerContracts(companyId: string, partnerId: string) {
  const rows = await db.contract.findMany({
    where: { companyId, partnerId },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    select: { id: true, number: true, status: true, startDate: true, endDate: true, billing: true },
  });
  const sums = rows.length
    ? await db.contractItem.groupBy({ by: ['contractId'], where: { contractId: { in: rows.map((r) => r.id) } }, _sum: { monthly: true }, _count: { _all: true } })
    : [];
  const by = new Map(sums.map((s) => [s.contractId, { monthly: num(s._sum.monthly), devices: s._count._all }]));
  return rows.map((r) => ({ ...r, ...(by.get(r.id) ?? { monthly: 0, devices: 0 }) }));
}

export async function partnerPrices(companyId: string, partnerId: string) {
  return db.priceAgreement.findMany({
    where: { companyId, partnerId },
    orderBy: [{ model: { brand: 'asc' } }, { model: { name: 'asc' } }],
    select: { id: true, modelId: true, salePrice: true, rentPrice: true, model: { select: { brand: true, name: true, salePrice: true, rentPrice: true } } },
  });
}

export interface LedgerRow {
  date: Date;
  kind: 'invoice' | 'payment';
  invoiceId: string;
  number: string | null;
  invKind: string | null;
  description: string | null;
  debit: number;
  credit: number;
  balance: number;
}

/**
 * Kartica partnera: izdani računi (duguje) i uplate (potražuje) po datumu, s
 * tekućim saldom izračunatim u bazi. Storno i odobrenje su negativni pa sami
 * umanjuju dug; kod konačnog računa oduzima se već plaćeni predujam.
 */
export async function partnerLedger(companyId: string, partnerId: string, page: { skip: number; take: number } = { skip: 0, take: 1000 }) {
  // stranica 1 = najnovije stavke (prikazane kronološki); saldo je tekući preko cijele kartice, zbrojevi agregatom
  const t = Prisma.sql`
      SELECT i."date", 'invoice' AS kind, i.id AS "invoiceId", i."number", i."kind"::text AS "invKind", i."description",
             (i."grandTotal" - i."advanceAmount") AS debit, 0::numeric AS credit, 0 AS ord, i."seq" AS seq, i.id AS rid
      FROM "Invoice" i
      WHERE i."companyId" = ${companyId} AND i."partnerId" = ${partnerId} AND i."status" = 'ISSUED'
      UNION ALL
      SELECT p."date", 'payment', i.id, i."number", NULL, p."note", 0::numeric, p."amount", 1, i."seq", p.id
      FROM "Payment" p JOIN "Invoice" i ON i.id = p."invoiceId"
      WHERE i."companyId" = ${companyId} AND i."partnerId" = ${partnerId} AND i."status" = 'ISSUED'`;
  const [rows, [sum]] = await Promise.all([
    db.$queryRaw<
      Array<{ date: Date; kind: 'invoice' | 'payment'; invoiceId: string; number: string | null; invKind: string | null; description: string | null; debit: Prisma.Decimal; credit: Prisma.Decimal; balance: Prisma.Decimal }>
    >`
    WITH t AS (${t}), r AS (
      SELECT *, SUM(debit - credit) OVER (ORDER BY "date", ord, seq, rid ROWS UNBOUNDED PRECEDING) AS balance,
             ROW_NUMBER() OVER (ORDER BY "date" DESC, ord DESC, seq DESC, rid DESC) AS rn
      FROM t
    )
    SELECT "date", kind, "invoiceId", "number", "invKind", "description", debit, credit, balance
    FROM r WHERE rn > ${page.skip} AND rn <= ${page.skip + page.take}
    ORDER BY "date", ord, seq, rid`,
    db.$queryRaw<Array<{ cnt: number; debit: Prisma.Decimal | null; credit: Prisma.Decimal | null }>>`
    SELECT COUNT(*)::int AS cnt, SUM(debit) AS debit, SUM(credit) AS credit FROM (${t}) t`,
  ]);
  const debit = num(sum.debit);
  const credit = num(sum.credit);
  return {
    rows: rows.map<LedgerRow>((r) => ({ ...r, debit: num(r.debit), credit: num(r.credit), balance: num(r.balance) })),
    total: sum.cnt,
    debit,
    credit,
    balance: r2(debit - credit),
  };
}
