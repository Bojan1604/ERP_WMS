import type { Tone } from '@/components/ui/misc';

export type ExpenseSourceCode = 'MANUAL' | 'RECEIPT' | 'WRITE_OFF' | 'SUPPLIER_INVOICE';

export const EXPENSE_SOURCE: Record<ExpenseSourceCode, { label: string; tone: Tone }> = {
  MANUAL: { label: 'ručno', tone: 'neutral' },
  RECEIPT: { label: 'primka', tone: 'info' },
  WRITE_OFF: { label: 'otpis', tone: 'bad' },
  SUPPLIER_INVOICE: { label: 'ulazni račun', tone: 'brand' },
};
