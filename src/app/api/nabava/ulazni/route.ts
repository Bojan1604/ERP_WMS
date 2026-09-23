import { requireAccess } from '@/server/auth';
import { listSupplierInvoices } from '@/server/queries/purchasing';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { csvResponse, toCsv } from '@/lib/csv';
import { date } from '@/lib/format';

/** Knjiga URA u CSV-u — isti filtri kao popis. */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('purchasing', 'view');
  } catch {
    return new Response('Nemate pravo pristupa.', { status: 403 });
  }
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const { rows } = await listSupplierInvoices(user.companyId, sp, { skip: 0, take: 20_000 });
  const csv = toCsv(rows, [
    { label: 'Interni broj', value: (r) => r.internalNo },
    { label: 'Broj računa', value: (r) => r.number },
    { label: 'Dobavljač', value: (r) => r.supplier.name },
    { label: 'Datum', value: (r) => date(r.issueDate) },
    { label: 'Dospijeće', value: (r) => (r.dueDate ? date(r.dueDate) : '') },
    { label: 'Kategorija', value: (r) => r.category },
    { label: 'Osnovica', value: (r) => num(r.netAmount) },
    { label: 'PDV', value: (r) => num(r.vatAmount) },
    { label: 'Ukupno', value: (r) => num(r.total) },
    { label: 'Plaćeno', value: (r) => (r.paidDate ? date(r.paidDate) : '') },
    { label: 'Knjižen trošak', value: (r) => (r.expense ? 'da' : 'ne') },
  ]);
  return csvResponse(csv, `ulazni-racuni-${toISO(new Date())}.csv`);
}
