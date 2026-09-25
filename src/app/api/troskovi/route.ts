import { requireAccess } from '@/server/auth';
import { canSeeCost } from '@/domain/permissions';
import { expensesForYear, parseExpenseFilters } from '@/server/queries/expenses';
import { FREQUENCY_LABEL, type FrequencyCode } from '@/domain/expenses';
import { EXPENSE_SOURCE } from '@/components/expenses/labels';
import { csvOrXlsx } from '@/server/xlsx';
import { date } from '@/lib/format';

/** Troškovi godine (s ratama ponavljajućih troškova) u CSV-u ili Excelu — isti filtri kao popis. */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('expenses', 'view');
  } catch {
    return new Response('Nemate pravo pristupa.', { status: 403 });
  }
  const f = parseExpenseFilters(Object.fromEntries(new URL(req.url).searchParams));
  // bez prava `costs` bez troškova nabave robe (primke, otpisi, računi za robu) — kao na stranici
  const { rows } = await expensesForYear(user.companyId, f, undefined, { costs: canSeeCost(user.perms) });
  return csvOrXlsx(
    req,
    rows,
    [
    { label: 'Datum', value: (r) => date(r.date), type: 'date' },
    { label: 'Kategorija', value: (r) => r.category },
    { label: 'Opis', value: (r) => r.description },
    { label: 'Partner', value: (r) => r.partner },
    { label: 'Neto', value: (r) => r.netAmount, type: 'money' },
    { label: 'PDV', value: (r) => r.vatAmount, type: 'money' },
    { label: 'Ukupno', value: (r) => r.total, type: 'money' },
    { label: 'Plaćeno', value: (r) => (r.paid ? 'da' : 'ne') },
    { label: 'Izvor', value: (r) => EXPENSE_SOURCE[r.source].label },
    { label: 'Dokument', value: (r) => r.receiptNumber ?? r.supplierInvoiceNo },
    { label: 'Ponavljanje', value: (r) => (r.frequency ? FREQUENCY_LABEL[r.frequency as FrequencyCode] : '') },
  ],
    `troskovi-${f.year}${f.month ? `-${String(f.month).padStart(2, '0')}` : ''}`,
    'Troškovi',
  );
}
