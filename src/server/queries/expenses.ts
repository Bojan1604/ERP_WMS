import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { expandExpense, type ExpenseInput, type FrequencyCode } from '@/domain/expenses';
import { fromISO, toISO, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';

type Params = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const ci = (q: string) => ({ contains: q, mode: 'insensitive' as const });

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
 */
export async function expensesForYear(companyId: string, f: ExpenseFilters) {
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
    ],
    ...(f.categoryId ? { categoryId: f.categoryId } : {}),
    ...(f.partnerId ? { partnerId: f.partnerId } : {}),
    ...(f.paid ? { paid: f.paid === 'yes' } : {}),
    ...(f.source ? { source: f.source } : {}),
  };
  const expenses = await db.expense.findMany({
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
      category: { select: { name: true } },
      partner: { select: { name: true } },
      receipt: { select: { number: true } },
      supplierInvoice: { select: { internalNo: true } },
    },
  });

  const now = today();
  const period = f.month ? `${f.year}-${String(f.month).padStart(2, '0')}` : null;
  const rows = [];
  const byMonth = Array.from({ length: 12 }, () => 0);
  const plannedByMonth = Array.from({ length: 12 }, () => 0);
  const byCategory = new Map<string, { name: string; net: number; vat: number; count: number }>();
  let recurringMonthly = 0;
  // ručni troškovi prikazani u tablici — podaci za obrazac izmjene
  const manual: Record<string, ManualExpense> = {};

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
      const cat = e.category?.name ?? 'Bez kategorije';
      const c = byCategory.get(cat) ?? { name: cat, net: 0, vat: 0, count: 0 };
      c.net += o.netAmount;
      c.vat += o.vatAmount;
      c.count++;
      byCategory.set(cat, c);
      if (e.source === 'MANUAL' && !manual[e.id]) {
        manual[e.id] = {
          id: e.id,
          date: input.date,
          categoryId: e.categoryId,
          description: e.description,
          partnerId: e.partnerId,
          netAmount: input.netAmount,
          vatAmount: input.vatAmount,
          paid: e.paid,
          frequency: input.frequency ?? null,
          recurringUntil: input.recurringUntil ?? null,
          note: e.note,
          overrides: (input.overrides ?? {}) as ManualExpense['overrides'],
        };
      }
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
        category: e.category?.name ?? null,
        partner: e.partner?.name ?? null,
        partnerId: e.partnerId,
        receiptId: e.receiptId,
        receiptNumber: e.receipt?.number ?? null,
        supplierInvoiceId: e.supplierInvoiceId,
        supplierInvoiceNo: e.supplierInvoice?.internalNo ?? null,
      });
    }
  }
  rows.sort((a, b) => (a.date === b.date ? a.description.localeCompare(b.description, 'hr') : a.date < b.date ? 1 : -1));
  const totals = {
    net: r2(rows.reduce((a, r) => a + r.netAmount, 0)),
    vat: r2(rows.reduce((a, r) => a + r.vatAmount, 0)),
    unpaid: r2(rows.filter((r) => !r.paid).reduce((a, r) => a + r.total, 0)),
    purchase: r2(rows.filter((r) => r.source === 'RECEIPT').reduce((a, r) => a + r.netAmount, 0)),
    planned: r2(plannedByMonth.reduce((a, v) => a + v, 0)),
    recurringMonthly: r2(recurringMonthly),
  };
  return {
    rows,
    manual,
    totals,
    byMonth: byMonth.map(r2),
    plannedByMonth: plannedByMonth.map(r2),
    byCategory: [...byCategory.values()].map((c) => ({ ...c, net: r2(c.net), vat: r2(c.vat) })).sort((a, b) => b.net - a.net),
  };
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

/** Partneri za odabir na trošku: dobavljači i svi koji se već pojavljuju na troškovima. */
export async function expensePartners(companyId: string) {
  return db.partner.findMany({
    where: { companyId, OR: [{ isSupplier: true }, { expenses: { some: {} } }] },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, country: true },
  });
}
