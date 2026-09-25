import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { expandExpense, type ExpenseInput, type FrequencyCode } from '@/domain/expenses';
import { fromISO, toISO, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { escapeLike } from '@/lib/like';

type Params = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const ci = (q: string) => ({ contains: escapeLike(q), mode: 'insensitive' as const });

export interface ExpenseFilters {
  year: number;
  month: number | null;
  categoryId: string | null;
  partnerId: string | null;
  q: string | null;
  paid: 'yes' | 'no' | null;
  source: 'MANUAL' | 'RECEIPT' | 'WRITE_OFF' | 'SUPPLIER_INVOICE' | null;
}

export function parseExpenseFilters(sp: Params): ExpenseFilters {
  const y = Number(str(sp.year));
  const m = Number(str(sp.month));
  const paid = str(sp.paid);
  const source = str(sp.source);
  return {
    year: Number.isInteger(y) && y > 1900 && y < 3000 ? y : Number(today().slice(0, 4)),
    month: Number.isInteger(m) && m >= 1 && m <= 12 ? m : null,
    categoryId: str(sp.category),
    partnerId: str(sp.partner),
    q: str(sp.q),
    paid: paid === 'yes' || paid === 'no' ? paid : null,
    source: source === 'MANUAL' || source === 'RECEIPT' || source === 'WRITE_OFF' || source === 'SUPPLIER_INVOICE' ? source : null,
  };
}

/**
 * Troškovi godine: baza vraća samo troškove koji mogu pasti u godinu
 * (jednokratni s datumom u godini, ponavljajući koji traju u godini), a
 * ponavljajući se zatim šire u pojedinačne rate (domain/expenses).
 * Zbrojevi (mjeseci, kategorije, ukupno) su uvijek preko svih rata; s `page` se vraća
 * samo ta stranica redaka (i podaci obrasca samo za nju), a nazivi partnera i
 * dokumenata se dohvaćaju samo za vraćene retke. Izvoz (bez `page`) dobiva sve.
 * Bez prava `costs` (`opts.costs = false`) troškovi koji otkrivaju nabavne vrijednosti — primke,
 * otpisi i ulazni računi za robu — ne ulaze ni u retke ni u zbrojeve (kao i drugdje bez tog prava).
 */
export async function expensesForYear(companyId: string, f: ExpenseFilters, page?: { skip: number; take: number }, opts: { costs?: boolean } = {}) {
  const from = `${f.year}-01-01`;
  const to = `${f.year}-12-31`;
  const where: Prisma.ExpenseWhereInput = {
    companyId,
    date: { lte: fromISO(to) },
    AND: [
      {
        OR: [
          { frequency: null, date: { gte: fromISO(from) } },
          { frequency: { not: null }, OR: [{ recurringUntil: null }, { recurringUntil: { gte: fromISO(from) } }] },
        ],
      },
      ...(f.q ? [{ OR: [{ description: ci(f.q) }, { note: ci(f.q) }, { partner: { name: ci(f.q) } }, { category: { name: ci(f.q) } }] }] : []),
      ...(opts.costs === false ? [COST_REVEALING_HIDDEN] : []),
    ],
    ...(f.categoryId ? { categoryId: f.categoryId } : {}),
    ...(f.partnerId ? { partnerId: f.partnerId } : {}),
    ...(f.paid ? { paid: f.paid === 'yes' } : {}),
    ...(f.source ? { source: f.source } : {}),
  };
  // naziv kategorije iz malog šifrarnika (relacija u upitu bi za tisuće troškova bila znatno sporija)
  const [expenses, categories] = await Promise.all([db.expense.findMany({
    where,
    select: {
      id: true,
      date: true,
      description: true,
      netAmount: true,
      vatAmount: true,
      paid: true,
      frequency: true,
      recurringUntil: true,
      overrides: true,
      source: true,
      note: true,
      categoryId: true,
      partnerId: true,
      receiptId: true,
      supplierInvoiceId: true,
    },
  }), db.expenseCategory.findMany({ where: { companyId }, select: { id: true, name: true } })]);
  const catName = new Map(categories.map((c) => [c.id, c.name]));

  const now = today();
  const period = f.month ? `${f.year}-${String(f.month).padStart(2, '0')}` : null;
  const rows: ExpenseRow[] = [];
  const byMonth = Array.from({ length: 12 }, () => 0);
  const plannedByMonth = Array.from({ length: 12 }, () => 0);
  const byCategory = new Map<string, { name: string; net: number; vat: number; count: number }>();
  let recurringMonthly = 0;
  // ručni troškovi prikazani u tablici — podaci za obrazac izmjene
  const manual: Record<string, ManualExpense> = {};
  const byId = new Map(expenses.map((e) => [e.id, e]));

  for (const e of expenses) {
    const input: ExpenseInput = {
      id: e.id,
      date: toISO(e.date),
      netAmount: num(e.netAmount),
      vatAmount: num(e.vatAmount),
      frequency: (e.frequency as FrequencyCode | null) ?? null,
      recurringUntil: e.recurringUntil ? toISO(e.recurringUntil) : null,
      overrides: (e.overrides as ExpenseInput['overrides']) ?? null,
    };
    const all = expandExpense(input, from, to, to);
    if (e.frequency && (!input.recurringUntil || input.recurringUntil >= now)) {
      recurringMonthly += input.netAmount / { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 }[e.frequency];
    }
    for (const o of all) {
      const m = Number(o.period.slice(5, 7)) - 1;
      // rate iza današnjeg dana su planirane, ne knjižene
      if (e.frequency && o.date > now) {
        if (!period || o.period === period) plannedByMonth[m] += o.netAmount;
        continue;
      }
      byMonth[m] += o.netAmount;
      if (period && o.period !== period) continue;
      const cat = (e.categoryId ? catName.get(e.categoryId) : undefined) ?? 'Bez kategorije';
      const c = byCategory.get(cat) ?? { name: cat, net: 0, vat: 0, count: 0 };
      c.net += o.netAmount;
      c.vat += o.vatAmount;
      c.count++;
      byCategory.set(cat, c);
      rows.push({
        key: o.key,
        expenseId: e.id,
        date: o.date,
        period: o.period,
        netAmount: o.netAmount,
        vatAmount: o.vatAmount,
        total: r2(o.netAmount + o.vatAmount),
        overridden: !!input.overrides?.[o.period],
        description: e.description,
        paid: e.paid,
        frequency: e.frequency,
        source: e.source,
        category: (e.categoryId ? catName.get(e.categoryId) : undefined) ?? null,
        partner: null,
        partnerId: e.partnerId,
        receiptId: e.receiptId,
        receiptNumber: null,
        supplierInvoiceId: e.supplierInvoiceId,
        supplierInvoiceNo: null,
      });
    }
  }
  const hr = new Intl.Collator('hr');
  rows.sort((a, b) => (a.date === b.date ? hr.compare(a.description, b.description) : a.date < b.date ? 1 : -1));
  const totals = {
    net: r2(rows.reduce((a, r) => a + r.netAmount, 0)),
    vat: r2(rows.reduce((a, r) => a + r.vatAmount, 0)),
    unpaid: r2(rows.filter((r) => !r.paid).reduce((a, r) => a + r.total, 0)),
    purchase: r2(rows.filter((r) => r.source === 'RECEIPT').reduce((a, r) => a + r.netAmount, 0)),
    planned: r2(plannedByMonth.reduce((a, v) => a + v, 0)),
    recurringMonthly: r2(recurringMonthly),
  };
  const shown = page ? rows.slice(page.skip, page.skip + page.take) : rows;
  // nazivi partnera i brojevi dokumenata samo za vraćene retke (u komadima zbog granice parametara)
  const ids = (pick: (r: (typeof rows)[number]) => string | null) => [...new Set(shown.map(pick).filter((x): x is string => !!x))];
  const [partners, receipts, supplierInvoices] = await Promise.all([
    chunked(ids((r) => r.partnerId), (x) => db.partner.findMany({ where: { companyId, id: { in: x } }, select: { id: true, name: true } })),
    chunked(ids((r) => r.receiptId), (x) => db.goodsReceipt.findMany({ where: { companyId, id: { in: x } }, select: { id: true, number: true } })),
    chunked(ids((r) => r.supplierInvoiceId), (x) => db.supplierInvoice.findMany({ where: { companyId, id: { in: x } }, select: { id: true, internalNo: true } })),
  ]);
  const pName = new Map(partners.map((p) => [p.id, p.name]));
  const rNo = new Map(receipts.map((r) => [r.id, r.number]));
  const siNo = new Map(supplierInvoices.map((x) => [x.id, x.internalNo]));
  for (const r of shown) {
    r.partner = r.partnerId ? pName.get(r.partnerId) ?? null : null;
    r.receiptNumber = r.receiptId ? rNo.get(r.receiptId) ?? null : null;
    r.supplierInvoiceNo = r.supplierInvoiceId ? siNo.get(r.supplierInvoiceId) ?? null : null;
    const e = byId.get(r.expenseId)!;
    // ručni troškovi prikazani u tablici — podaci za obrazac izmjene
    if (e.source === 'MANUAL' && !manual[e.id]) {
      manual[e.id] = {
        id: e.id,
        date: toISO(e.date),
        categoryId: e.categoryId,
        description: e.description,
        partnerId: e.partnerId,
        netAmount: num(e.netAmount),
        vatAmount: num(e.vatAmount),
        paid: e.paid,
        frequency: (e.frequency as FrequencyCode | null) ?? null,
        recurringUntil: e.recurringUntil ? toISO(e.recurringUntil) : null,
        note: e.note,
        overrides: ((e.overrides as ExpenseInput['overrides']) ?? {}) as ManualExpense['overrides'],
      };
    }
  }
  return {
    rows: shown,
    rowCount: rows.length,
    manual,
    totals,
    byMonth: byMonth.map(r2),
    plannedByMonth: plannedByMonth.map(r2),
    byCategory: [...byCategory.values()].map((c) => ({ ...c, net: r2(c.net), vat: r2(c.vat) })).sort((a, b) => b.net - a.net),
  };
}

/** Troškovi koji otkrivaju nabavnu vrijednost robe (primka, otpis, ulazni račun za robu) — skriveni bez prava `costs`. */
const COST_REVEALING_HIDDEN: Prisma.ExpenseWhereInput = {
  source: { notIn: ['RECEIPT', 'WRITE_OFF'] },
  NOT: { source: 'SUPPLIER_INVOICE', supplierInvoice: { is: { goodsInvoice: true } } },
};

export interface ExpenseRow {
  key: string;
  expenseId: string;
  date: string;
  period: string;
  netAmount: number;
  vatAmount: number;
  total: number;
  overridden: boolean;
  description: string;
  paid: boolean;
  frequency: string | null;
  source: 'MANUAL' | 'RECEIPT' | 'WRITE_OFF' | 'SUPPLIER_INVOICE';
  category: string | null;
  partner: string | null;
  partnerId: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
  supplierInvoiceId: string | null;
  supplierInvoiceNo: string | null;
}

async function chunked<T>(ids: string[], fn: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 10_000) out.push(...(await fn(ids.slice(i, i + 10_000))));
  return out;
}

export interface ManualExpense {
  id: string;
  date: string;
  categoryId: string | null;
  description: string;
  partnerId: string | null;
  netAmount: number;
  vatAmount: number;
  paid: boolean;
  frequency: FrequencyCode | null;
  recurringUntil: string | null;
  note: string | null;
  overrides: Record<string, { amount?: number; skipped?: boolean }>;
}

export async function expenseYears(companyId: string) {
  const rows = await db.$queryRaw<{ y: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM "date")::int AS y FROM "Expense" WHERE "companyId" = ${companyId} ORDER BY y DESC`;
  const now = Number(today().slice(0, 4));
  const years = new Set([now, ...rows.map((r) => r.y)]);
  return [...years].sort((a, b) => b - a);
}

