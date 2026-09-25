import { requireAccess } from '@/server/auth';
import { listSupplierInvoices } from '@/server/queries/purchasing';
import { toISO } from '@/domain/dates';
import { SUPPLIER_INVOICE_STATUS_LABEL } from '@/domain/einvoice-inbound';
import { num } from '@/domain/money';
import { csvOrXlsx } from '@/server/xlsx';
import { date } from '@/lib/format';
import { vatPctOf } from '@/domain/purchase-links';

/** Knjiga URA u CSV-u ili Excelu — isti filtri kao popis. */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('purchasing', 'view');
  } catch {
    return new Response('Nemate pravo pristupa.', { status: 403 });
  }
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const { rows } = await listSupplierInvoices(user.companyId, sp, { skip: 0, take: 20_000 });
  return csvOrXlsx(
    req,
    rows,
    [
    { label: 'Interni broj', value: (r) => r.internalNo },
    { label: 'Broj računa', value: (r) => r.number },
    { label: 'Dobavljač', value: (r) => r.supplier.name },
    { label: 'OIB', value: (r) => r.supplierOib ?? r.supplier.oib },
    { label: 'Datum', value: (r) => date(r.issueDate), type: 'date' },
    { label: 'Dospijeće', value: (r) => (r.dueDate ? date(r.dueDate) : ''), type: 'date' },
    { label: 'Kategorija', value: (r) => r.category },
    { label: 'Osnovica', value: (r) => num(r.netAmount), type: 'money' },
    { label: 'PDV', value: (r) => num(r.vatAmount), type: 'money' },
    { label: 'PDV %', value: (r) => (r.vatPct !== null ? num(r.vatPct) : vatPctOf(num(r.netAmount), num(r.vatAmount))), type: 'number' },
    { label: 'Ukupno', value: (r) => num(r.total), type: 'money' },
    { label: 'Valuta', value: (r) => r.currency },
    { label: 'Plaćeno', value: (r) => (r.paidDate ? date(r.paidDate) : ''), type: 'date' },
    { label: 'Knjižen trošak', value: (r) => (r.expense ? 'da' : 'ne') },
    { label: 'Status', value: (r) => SUPPLIER_INVOICE_STATUS_LABEL[r.status] },
    { label: 'Izvor', value: (r) => (r.source === 'EINVOICE' ? 'eRačun' : 'ručno') },
  ],
    `ulazni-racuni-${toISO(new Date())}`,
    'Ulazni računi',
  );
}
