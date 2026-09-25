import 'server-only';
import type { FiscalStatus, Prisma } from '@prisma/client';
import { db } from '../db';
import { getCompany } from './lookups';
import { readMeta } from '../fiscal/issue';
import { ACCOUNTANT_ROW_CAP, directionsOf, rowKey, type AccountantFilters, type AccountantKind, type Direction } from '@/domain/accountant';
import { paymentState, type PaymentState } from '@/domain/invoice';
import { fromISO, toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { escapeLike } from '@/lib/like';
import { can, canSeeCost, type PermissionMap } from '@/domain/permissions';

/**
 * Knjigovođa: izdani izlazni računi i ulazni računi u razdoblju. Filtriranje i
 * zbrojevi idu u bazi; popis je po smjeru ograničen na ACCOUNTANT_ROW_CAP redaka.
 * Bez prava „nabavne cijene i marže" (`costs`) iznosi ulaznih računa za robu su `null`, ne ulaze u
 * zbrojeve, a njihovi prilozi ne idu u ZIP (kao Knjiga URA na /nabava/ulazni).
 */

/** Što korisnik smije vidjeti: izlazne (prodaja), ulazne (nabava) i iznose računa za robu (`costs`). */
export interface AccountantAccess {
  out: boolean;
  in: boolean;
  costs?: boolean;
}

export const accountantAccess = (perms: PermissionMap): Required<AccountantAccess> => ({
  out: can(perms, 'sales', 'view'),
  in: can(perms, 'purchasing', 'view'),
  costs: canSeeCost(perms),
});

/** Ulazni računi čiji iznosi ne otkrivaju nabavnu vrijednost robe. */
export const NOT_GOODS_INVOICE: Prisma.SupplierInvoiceWhereInput = { OR: [{ goodsInvoice: null }, { goodsInvoice: false }] };

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
  /** `null` — iznos računa za robu skriven (korisnik bez prava `costs`). */
  net: number | null;
  vat: number | null;
  total: number | null;
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
    where: { companyId, OR: [{ name: { contains: escapeLike(q), mode: 'insensitive' } }, { oib: { startsWith: escapeLike(q.replace(/\s+/g, '')) } }] },
    select: { id: true },
    take: 500,
  });
  return rows.map((r) => r.id);
}

const sentWhere = (sent: AccountantFilters['sent']) => (sent === 'da' ? { accountantSentAt: { not: null } } : sent === 'ne' ? { accountantSentAt: null } : {});

export function outboundWhere(companyId: string, f: AccountantFilters, partnerIds: string[]): Prisma.InvoiceWhereInput {
  const and: Prisma.InvoiceWhereInput[] = [{ companyId, status: 'ISSUED', date: { gte: fromISO(f.from), lte: fromISO(f.to) } }, sentWhere(f.sent)];
  if (f.kind && f.kind !== 'INBOUND') and.push({ kind: f.kind });
  if (f.q) and.push({ OR: [{ number: { contains: escapeLike(f.q), mode: 'insensitive' } }, ...(partnerIds.length ? [{ partnerId: { in: partnerIds } }] : [])] });
  return { AND: and };
}

export function inboundWhere(companyId: string, f: AccountantFilters, partnerIds: string[]): Prisma.SupplierInvoiceWhereInput {
  // odbijeni ulazni račun (Fiskalizacija 2.0) nije knjigovodstvena isprava
  const and: Prisma.SupplierInvoiceWhereInput[] = [{ companyId, status: { not: 'REJECTED' }, issueDate: { gte: fromISO(f.from), lte: fromISO(f.to) } }, sentWhere(f.sent)];
  if (f.q) {
    const c = { contains: escapeLike(f.q), mode: 'insensitive' as const };
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
  goodsInvoice: true,
  supplierOib: true,
  supplier: { select: { name: true, oib: true } },
} satisfies Prisma.SupplierInvoiceSelect;

async function attachmentCounts(companyId: string, entity: string, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const g = await db.attachment.groupBy({ by: ['entityId'], where: { companyId, entity, entityId: { in: ids } }, _count: { _all: true } });
  return new Map(g.map((x) => [x.entityId, x._count._all]));
}

type Where = { out: Prisma.InvoiceWhereInput | null; in: Prisma.SupplierInvoiceWhereInput | null };

const OUT_ORDER: Prisma.InvoiceOrderByWithRelationInput[] = [{ date: 'desc' }, { seq: 'desc' }];
const IN_ORDER: Prisma.SupplierInvoiceOrderByWithRelationInput[] = [{ issueDate: 'desc' }, { internalNo: 'desc' }];

/** Najnoviji prvi; unutar dana izlazni pa ulazni (unutar smjera ostaje redoslijed iz baze). */
const byDate = (a: { date: string; dir: Direction }, b: { date: string; dir: Direction }) =>
  a.date === b.date ? (a.dir === b.dir ? 0 : a.dir === 'out' ? -1 : 1) : a.date < b.date ? 1 : -1;

/**
 * Redoslijed popisa samo s ključevima (id i datum) — prvih `take` po smjeru, spojeno
 * kao `loadAccountantRows`. Za straničenje i „označi sve po filtru" bez učitavanja redaka.
 */
async function orderedKeys(where: Where, take: number) {
  const [outs, ins] = await Promise.all([
    where.out ? db.invoice.findMany({ where: where.out, select: { id: true, date: true }, orderBy: OUT_ORDER, take }) : [],
    where.in ? db.supplierInvoice.findMany({ where: where.in, select: { id: true, issueDate: true }, orderBy: IN_ORDER, take }) : [],
  ]);
  return [
    ...outs.map((r) => ({ dir: 'out' as const, id: r.id, date: toISO(r.date) })),
    ...ins.map((r) => ({ dir: 'in' as const, id: r.id, date: toISO(r.issueDate) })),
  ].sort(byDate);
}

/** Retci za zadane uvjete — zajedničko za popis, ZIP i ispis. */
export async function loadAccountantRows(companyId: string, where: Where, take = ACCOUNTANT_ROW_CAP, costs = true): Promise<AccountantRow[]> {
  const [company, outs, ins] = await Promise.all([
    getCompany(companyId),
    where.out ? db.invoice.findMany({ where: where.out, select: outSelect, orderBy: OUT_ORDER, take }) : [],
    where.in ? db.supplierInvoice.findMany({ where: where.in, select: inSelect, orderBy: IN_ORDER, take }) : [],
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
    const hide = !costs && r.goodsInvoice === true;
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
      net: hide ? null : num(r.netAmount),
      vat: hide ? null : num(r.vatAmount),
      total: hide ? null : num(r.total),
      status: r.paidDate ? 'Plaćeno' : 'Nije plaćeno',
      statusTone: r.paidDate ? 'positive' : 'warning',
      sentAt: r.accountantSentAt ? r.accountantSentAt.toISOString() : null,
      // prilozi računa za robu (račun dobavljača) otkrivaju nabavnu vrijednost
      attachments: hide ? 0 : (inAtt.get(r.id) ?? 0),
      fiscal: null,
      // ulazni eRačun (preuzet od posrednika) — oznaka u stupcu eRačun
      eInvoice: r.source === 'EINVOICE' ? 'INBOUND' : null,
    });
  }
  return rows.sort(byDate);
}

/** Uvjeti popisa za filtre i prava korisnika (izlazne vidi samo tko vidi prodaju, ulazne tko vidi nabavu). */
async function accountantWhere(companyId: string, f: AccountantFilters, allowed: AccountantAccess) {
  const d0 = directionsOf(f);
  const dirs = { out: d0.out && allowed.out, in: d0.in && allowed.in };
  const partnerIds = await partnerIdsFor(companyId, f.q);
  const where: Where = { out: dirs.out ? outboundWhere(companyId, f, partnerIds) : null, in: dirs.in ? inboundWhere(companyId, f, partnerIds) : null };
  return { dirs, where };
}

/**
 * Popis za stranicu: jedna stranica redaka (od najviše ACCOUNTANT_ROW_CAP po smjeru) i
 * zbrojevi po smjeru nad svim filtriranim zapisima. Bez `page` — svi retci do granice (izvoz).
 */
export async function listAccountant(
  companyId: string,
  f: AccountantFilters,
  allowed: AccountantAccess = { out: true, in: true },
  page?: { skip: number; take: number },
) {
  const { dirs, where } = await accountantWhere(companyId, f, allowed);
  const costs = allowed.costs !== false;
  const wOut = where.out;
  const wIn = where.in;
  // zbrojevi ulaznih bez prava `costs` — bez računa za robu (broj dokumenata ostaje pun)
  const wInSum = wIn && !costs ? { AND: [wIn, NOT_GOODS_INVOICE] } : wIn;
  const loadPage = async () => {
    if (!page) return loadAccountantRows(companyId, where, ACCOUNTANT_ROW_CAP, costs);
    // redoslijed samo po ključevima, zatim puni retci jedne stranice
    const keys = (await orderedKeys(where, Math.min(page.skip + page.take, ACCOUNTANT_ROW_CAP))).slice(page.skip, page.skip + page.take);
    const outIds = keys.filter((k) => k.dir === 'out').map((k) => k.id);
    const inIds = keys.filter((k) => k.dir === 'in').map((k) => k.id);
    return loadAccountantRows(companyId, {
      out: wOut && outIds.length ? { AND: [wOut, { id: { in: outIds } }] } : null,
      in: wIn && inIds.length ? { AND: [wIn, { id: { in: inIds } }] } : null,
    }, ACCOUNTANT_ROW_CAP, costs);
  };
  const [rows, outAgg, outNotSent, inAgg, inSum, inNotSent] = await Promise.all([
    loadPage(),
    wOut ? db.invoice.aggregate({ where: wOut, _count: { _all: true }, _sum: { netTotal: true, vatTotal: true, grandTotal: true } }) : null,
    wOut && f.sent !== 'da' ? db.invoice.count({ where: { AND: [wOut, { accountantSentAt: null }] } }) : 0,
    wIn ? db.supplierInvoice.aggregate({ where: wIn, _count: { _all: true } }) : null,
    wInSum ? db.supplierInvoice.aggregate({ where: wInSum, _sum: { netAmount: true, vatAmount: true, total: true } }) : null,
    wIn && f.sent !== 'da' ? db.supplierInvoice.count({ where: { AND: [wIn, { accountantSentAt: null }] } }) : 0,
  ]);
  const out: DirTotals = outAgg
    ? { count: outAgg._count._all, net: num(outAgg._sum.netTotal), vat: num(outAgg._sum.vatTotal), total: num(outAgg._sum.grandTotal), notSent: outNotSent }
    : EMPTY;
  const inb: DirTotals = inAgg
    ? { count: inAgg._count._all, net: num(inSum?._sum.netAmount), vat: num(inSum?._sum.vatAmount), total: num(inSum?._sum.total), notSent: inNotSent }
    : EMPTY;
  // broj redaka u popisu (straničenje): najviše ACCOUNTANT_ROW_CAP po smjeru
  const listed = Math.min(out.count, ACCOUNTANT_ROW_CAP) + Math.min(inb.count, ACCOUNTANT_ROW_CAP);
  return { rows, totals: { out, in: inb, inGoodsHidden: !costs }, listed, capped: out.count > ACCOUNTANT_ROW_CAP || inb.count > ACCOUNTANT_ROW_CAP, dirs };
}

/** „Označi sve po filtru": ključevi svih dokumenata popisa (najviše ACCOUNTANT_ROW_CAP po smjeru), redom popisa. */
export async function accountantKeysByFilter(companyId: string, f: AccountantFilters, allowed: AccountantAccess) {
  const { where } = await accountantWhere(companyId, f, allowed);
  return (await orderedKeys(where, ACCOUNTANT_ROW_CAP)).map((k) => rowKey(k.dir, k.id));
}

/** Retci za označene ključeve — uvijek suženo na firmu; izlazni samo izdani. */
export function accountantRowsByIds(companyId: string, ids: { out: string[]; in: string[] }, costs = true) {
  return loadAccountantRows(
    companyId,
    {
      out: ids.out.length ? { companyId, status: 'ISSUED', id: { in: ids.out } } : null,
      in: ids.in.length ? { companyId, id: { in: ids.in } } : null,
    },
    ACCOUNTANT_ROW_CAP,
    costs,
  );
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
