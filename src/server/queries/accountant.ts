import 'server-only';
import type { FiscalStatus, Prisma } from '@prisma/client';
import { db } from '../db';
import { getCompany } from './lookups';
import { readMeta } from '../fiscal/issue';
import { ACCOUNTANT_ROW_CAP, directionsOf, rowKey, type AccountantFilters, type AccountantKind, type Direction } from '@/domain/accountant';
import { paymentState, type PaymentState } from '@/domain/invoice';
import { fromISO, toISO } from '@/domain/dates';
import { num } from '@/domain/money';

/**
 * Knjigovođa: izdani izlazni računi i ulazni računi u razdoblju. Filtriranje i
 * zbrojevi idu u bazi; popis je po smjeru ograničen na ACCOUNTANT_ROW_CAP redaka.
 */

export interface AccountantRow {
  key: string;
  dir: Direction;
  id: string;
  date: string;
  number: string;
  /** Interni broj ulaznog računa (URA). */
  internalNo: string | null;
  partner: string;
  oib: string | null;
  kind: AccountantKind;
  net: number;
  vat: number;
  total: number;
  status: string;
  statusTone: PaymentState['tone'];
  sentAt: string | null;
  attachments: number;
  fiscal: FiscalStatus | null;
  /** Stanje eRačuna kod posrednika (izlazni) — null ako se ne šalje. */
  eInvoice: string | null;
}

export interface DirTotals {
  count: number;
  net: number;
  vat: number;
  total: number;
  notSent: number;
}

const EMPTY: DirTotals = { count: 0, net: 0, vat: 0, total: 0, notSent: 0 };

/** Partneri čiji naziv (trigram indeks) ili OIB odgovara pretrazi — razrješava se unaprijed u id-eve. */
async function partnerIdsFor(companyId: string, q: string) {
  if (!q) return [];
  const rows = await db.partner.findMany({
    where: { companyId, OR: [{ name: { contains: q, mode: 'insensitive' } }, { oib: { startsWith: q.replace(/\s+/g, '') } }] },
    select: { id: true },
    take: 500,
  });
  return rows.map((r) => r.id);
}

const sentWhere = (sent: AccountantFilters['sent']) => (sent === 'da' ? { accountantSentAt: { not: null } } : sent === 'ne' ? { accountantSentAt: null } : {});

export function outboundWhere(companyId: string, f: AccountantFilters, partnerIds: string[]): Prisma.InvoiceWhereInput {
  const and: Prisma.InvoiceWhereInput[] = [{ companyId, status: 'ISSUED', date: { gte: fromISO(f.from), lte: fromISO(f.to) } }, sentWhere(f.sent)];
  if (f.kind && f.kind !== 'INBOUND') and.push({ kind: f.kind });
  if (f.q) and.push({ OR: [{ number: { contains: f.q, mode: 'insensitive' } }, ...(partnerIds.length ? [{ partnerId: { in: partnerIds } }] : [])] });
  return { AND: and };
}

export function inboundWhere(companyId: string, f: AccountantFilters, partnerIds: string[]): Prisma.SupplierInvoiceWhereInput {
  // odbijeni ulazni račun (Fiskalizacija 2.0) nije knjigovodstvena isprava
  const and: Prisma.SupplierInvoiceWhereInput[] = [{ companyId, status: { not: 'REJECTED' }, issueDate: { gte: fromISO(f.from), lte: fromISO(f.to) } }, sentWhere(f.sent)];
  if (f.q) {
    const c = { contains: f.q, mode: 'insensitive' as const };
    and.push({ OR: [{ number: c }, { internalNo: c }, ...(partnerIds.length ? [{ supplierId: { in: partnerIds } }] : [])] });
  }
  return { AND: and };
}

const outSelect = {
  id: true,
  number: true,
  status: true,
  kind: true,
  stornoed: true,
  date: true,
  dueDate: true,
  netTotal: true,
  vatTotal: true,
  grandTotal: true,
  paidTotal: true,
  openAmount: true,
  paidDate: true,
  fiscalStatus: true,
  eInvoice: true,
  accountantSentAt: true,
  partner: { select: { name: true, oib: true } },
} satisfies Prisma.InvoiceSelect;

const inSelect = {
  id: true,
  internalNo: true,
  number: true,
  issueDate: true,
  dueDate: true,
  netAmount: true,
  vatAmount: true,
  total: true,
  paidDate: true,
  accountantSentAt: true,
  source: true,
  supplierOib: true,
  supplier: { select: { name: true, oib: true } },
} satisfies Prisma.SupplierInvoiceSelect;

async function attachmentCounts(companyId: string, entity: string, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const g = await db.attachment.groupBy({ by: ['entityId'], where: { companyId, entity, entityId: { in: ids } }, _count: { _all: true } });
  return new Map(g.map((x) => [x.entityId, x._count._all]));
}

/** Retci za zadane uvjete — zajedničko za popis, ZIP i ispis. */
export async function loadAccountantRows(
  companyId: string,
  where: { out: Prisma.InvoiceWhereInput | null; in: Prisma.SupplierInvoiceWhereInput | null },
  take = ACCOUNTANT_ROW_CAP,
): Promise<AccountantRow[]> {
  const [company, outs, ins] = await Promise.all([
    getCompany(companyId),
    where.out ? db.invoice.findMany({ where: where.out, select: outSelect, orderBy: [{ date: 'desc' }, { seq: 'desc' }], take }) : [],
    where.in ? db.supplierInvoice.findMany({ where: where.in, select: inSelect, orderBy: [{ issueDate: 'desc' }, { internalNo: 'desc' }], take }) : [],
  ]);
  const [outAtt, inAtt] = await Promise.all([
    attachmentCounts(companyId, 'invoice', outs.map((r) => r.id)),
    attachmentCounts(companyId, 'supplierInvoice', ins.map((r) => r.id)),
  ]);
  const rows: AccountantRow[] = [];
  for (const r of outs) {
    const st = paymentState(
      {
        status: r.status,
        kind: r.kind,
        stornoed: r.stornoed,
        date: toISO(r.date),
        dueDate: r.dueDate ? toISO(r.dueDate) : null,
        total: num(r.grandTotal),
        paid: num(r.paidTotal),
        open: num(r.openAmount),
        lastPaymentDate: r.paidDate ? toISO(r.paidDate) : null,
      },
      company.overdueDays,
    );
    const meta = readMeta(r.eInvoice);
    rows.push({
      key: rowKey('out', r.id),
      dir: 'out',
      id: r.id,
      date: toISO(r.date),
      number: r.number ?? '',
      internalNo: null,
      partner: r.partner.name,
      oib: r.partner.oib,
      kind: r.kind,
      net: num(r.netTotal),
      vat: num(r.vatTotal),
      total: num(r.grandTotal),
      status: st.label,
      statusTone: st.tone,
      sentAt: r.accountantSentAt ? r.accountantSentAt.toISOString() : null,
      attachments: outAtt.get(r.id) ?? 0,
      fiscal: r.fiscalStatus === 'NOT_REQUIRED' ? null : r.fiscalStatus,
      eInvoice: meta.route === 'EINVOICE' ? (meta.status ?? 'PENDING') : null,
    });
  }
  for (const r of ins) {
    rows.push({
      key: rowKey('in', r.id),
      dir: 'in',
      id: r.id,
      date: toISO(r.issueDate),
      number: r.number,
      internalNo: r.internalNo,
      partner: r.supplier.name,
      oib: r.supplier.oib ?? r.supplierOib,
      kind: 'INBOUND',
      net: num(r.netAmount),
      vat: num(r.vatAmount),
      total: num(r.total),
      status: r.paidDate ? 'Plaćeno' : 'Nije plaćeno',
      statusTone: r.paidDate ? 'positive' : 'warning',
      sentAt: r.accountantSentAt ? r.accountantSentAt.toISOString() : null,
      attachments: inAtt.get(r.id) ?? 0,
      fiscal: null,
      // ulazni eRačun (preuzet od posrednika) — oznaka u stupcu eRačun
      eInvoice: r.source === 'EINVOICE' ? 'INBOUND' : null,
    });
  }
  // najnoviji prvi; unutar dana izlazni pa ulazni
  return rows.sort((a, b) => (a.date === b.date ? (a.dir === b.dir ? 0 : a.dir === 'out' ? -1 : 1) : a.date < b.date ? 1 : -1));
}

/** Popis za stranicu: retci (ograničeni) i zbrojevi po smjeru nad svim filtriranim zapisima. */
export async function listAccountant(companyId: string, f: AccountantFilters, allowed: { out: boolean; in: boolean } = { out: true, in: true }) {
  // izlazne vidi samo tko vidi prodaju, ulazne tko vidi nabavu
  const d0 = directionsOf(f);
  const dirs = { out: d0.out && allowed.out, in: d0.in && allowed.in };
  const partnerIds = await partnerIdsFor(companyId, f.q);
  const wOut = dirs.out ? outboundWhere(companyId, f, partnerIds) : null;
  const wIn = dirs.in ? inboundWhere(companyId, f, partnerIds) : null;
  const [rows, outAgg, outNotSent, inAgg, inNotSent] = await Promise.all([
    loadAccountantRows(companyId, { out: wOut, in: wIn }),
    wOut ? db.invoice.aggregate({ where: wOut, _count: { _all: true }, _sum: { netTotal: true, vatTotal: true, grandTotal: true } }) : null,
    wOut && f.sent !== 'da' ? db.invoice.count({ where: { AND: [wOut, { accountantSentAt: null }] } }) : 0,
    wIn ? db.supplierInvoice.aggregate({ where: wIn, _count: { _all: true }, _sum: { netAmount: true, vatAmount: true, total: true } }) : null,
    wIn && f.sent !== 'da' ? db.supplierInvoice.count({ where: { AND: [wIn, { accountantSentAt: null }] } }) : 0,
  ]);
  const out: DirTotals = outAgg
    ? { count: outAgg._count._all, net: num(outAgg._sum.netTotal), vat: num(outAgg._sum.vatTotal), total: num(outAgg._sum.grandTotal), notSent: outNotSent }
    : EMPTY;
  const inb: DirTotals = inAgg
    ? { count: inAgg._count._all, net: num(inAgg._sum.netAmount), vat: num(inAgg._sum.vatAmount), total: num(inAgg._sum.total), notSent: inNotSent }
    : EMPTY;
  return { rows, totals: { out, in: inb }, capped: out.count > ACCOUNTANT_ROW_CAP || inb.count > ACCOUNTANT_ROW_CAP, dirs };
}

/** Retci za označene ključeve — uvijek suženo na firmu; izlazni samo izdani. */
export function accountantRowsByIds(companyId: string, ids: { out: string[]; in: string[] }) {
  return loadAccountantRows(companyId, {
    out: ids.out.length ? { companyId, status: 'ISSUED', id: { in: ids.out } } : null,
    in: ids.in.length ? { companyId, id: { in: ids.in } } : null,
  });
}

/** Izdani izlazni računi za skupni ispis (A4, jedan po stranici) — podaci kao na stranici računa. */
export function invoicesForPrint(companyId: string, ids: string[]) {
  if (!ids.length) return Promise.resolve([]);
  return db.invoice.findMany({
    where: { companyId, status: 'ISSUED', id: { in: ids.slice(0, ACCOUNTANT_ROW_CAP) } },
    orderBy: [{ date: 'asc' }, { seq: 'asc' }],
    include: {
      partner: true,
      refInvoice: { select: { number: true, date: true } },
      lines: {
        orderBy: { sort: 'asc' },
        include: { item: { select: { serial: true } }, model: { select: { code: true, kpd: true } }, service: { select: { kpd: true } } },
      },
    },
  });
}
