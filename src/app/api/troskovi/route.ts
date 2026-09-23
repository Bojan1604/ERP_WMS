import { requireAccess } from '@/server/auth';
import { expensesForYear, parseExpenseFilters } from '@/server/queries/expenses';
import { FREQUENCY_LABEL, type FrequencyCode } from '@/domain/expenses';
import { EXPENSE_SOURCE } from '@/components/expenses/labels';
import { csvResponse, toCsv } from '@/lib/csv';
import { date } from '@/lib/format';

/** Troškovi godine (s ratama ponavljajućih troškova) u CSV-u — isti filtri kao popis. */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('expenses', 'view');
  } catch {
    return new Response('Nemate pravo pristupa.', { status: 403 });
  }
  const f = parseExpenseFilters(Object.fromEntries(new URL(req.url).searchParams));
  const { rows } = await expensesForYear(user.companyId, f);
  const csv = toCsv(rows, [
    { label: 'Datum', value: (r) => date(r.date) },
    { label: 'Kategorija', value: (r) => r.category },
    { label: 'Opis', value: (r) => r.description },
    { label: 'Partner', value: (r) => r.partner },
    { label: 'Neto', value: (r) => r.netAmount },
    { label: 'PDV', value: (r) => r.vatAmount },
    { label: 'Ukupno', value: (r) => r.total },
    { label: 'Plaćeno', value: (r) => (r.paid ? 'da' : 'ne') },
    { label: 'Izvor', value: (r) => EXPENSE_SOURCE[r.source].label },
    { label: 'Dokument', value: (r) => r.receiptNumber ?? r.supplierInvoiceNo },
    { label: 'Ponavljanje', value: (r) => (r.frequency ? FREQUENCY_LABEL[r.frequency as FrequencyCode] : '') },
  ]);
  return csvResponse(csv, `troskovi-${f.year}${f.month ? `-${String(f.month).padStart(2, '0')}` : ''}.csv`);
}
