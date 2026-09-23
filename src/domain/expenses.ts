import { addMonths, today, type ISODate, type Period } from './dates';

export type FrequencyCode = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';

export const FREQUENCY_MONTHS: Record<FrequencyCode, number> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 };
export const FREQUENCY_LABEL: Record<FrequencyCode, string> = {
  MONTHLY: 'Mjesečno',
  QUARTERLY: 'Kvartalno',
  SEMIANNUAL: 'Polugodišnje',
  ANNUAL: 'Godišnje',
};

export interface ExpenseInput {
  id: string;
  date: ISODate;
  netAmount: number;
  vatAmount: number;
  frequency?: FrequencyCode | null;
  recurringUntil?: ISODate | null;
  overrides?: Record<Period, { amount?: number; skipped?: boolean }> | null;
}

export interface ExpenseOccurrence {
  expenseId: string;
  key: string;
  date: ISODate;
  period: Period;
  netAmount: number;
  vatAmount: number;
  virtual: boolean;
}

/**
 * Ponavljajući trošak se širi u pojedinačne rate u rasponu [from, to].
 * Buduće rate (iza `bookedUntil`, zadano danas) se ne knjiže — za prikaz
 * planiranog iznosa pozivatelj prosljeđuje kraj godine.
 */
export function expandExpense(e: ExpenseInput, from: ISODate, to: ISODate, bookedUntil: ISODate = today()): ExpenseOccurrence[] {
  const end = [to, bookedUntil, e.recurringUntil || '9999-12-31'].sort()[0];
  if (!e.frequency) {
    return e.date >= from && e.date <= to
      ? [{ expenseId: e.id, key: e.id, date: e.date, period: e.date.slice(0, 7), netAmount: e.netAmount, vatAmount: e.vatAmount, virtual: false }]
      : [];
  }
  const step = FREQUENCY_MONTHS[e.frequency];
  const out: ExpenseOccurrence[] = [];
  for (let k = 0; k < 1200; k++) {
    const d = addMonths(e.date, k * step);
    if (d > end) break;
    if (d < from) continue;
    const p = d.slice(0, 7);
    const ov = e.overrides?.[p];
    if (ov?.skipped) continue;
    const ratio = ov?.amount !== undefined && e.netAmount ? ov.amount / e.netAmount : 1;
    out.push({
      expenseId: e.id,
      key: `${e.id}:${p}`,
      date: d,
      period: p,
      netAmount: ov?.amount ?? e.netAmount,
      vatAmount: Math.round(e.vatAmount * ratio * 100) / 100,
      virtual: k > 0,
    });
  }
  return out;
}
