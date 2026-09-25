import { requireAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { accountantAccess, listAccountant, type AccountantRow } from '@/server/queries/accountant';
import { csvOrXlsx } from '@/server/xlsx';
import type { ExportColumn } from '@/lib/csv';
import { ACCOUNTANT_KIND_LABEL, accountantEInvoiceLabel, readAccountantFilters } from '@/domain/accountant';
import { FISCAL_STATUS_LABEL } from '@/domain/fiscal';
import { formatDate } from '@/domain/dates';


/** Popis knjigovođe (Excel / CSV / PDF) — isti filtri i razdoblje kao stranica. */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('reports', 'view');
  } catch {
    return new Response('Nemate pravo pristupa.', { status: 403 });
  }
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const f = readAccountantFilters(sp);
  const [list, company] = await Promise.all([
    listAccountant(user.companyId, f, accountantAccess(user.perms)),
    getCompany(user.companyId),
  ]);
  const columns: ExportColumn<AccountantRow>[] = [
    { label: 'Broj', value: (r) => r.number },
    { label: 'Interni broj', value: (r) => r.internalNo },
    { label: 'Smjer', value: (r) => (r.dir === 'out' ? 'Izlazni' : 'Ulazni') },
    { label: 'Datum', value: (r) => formatDate(r.date), type: 'date' },
    { label: 'Partner', value: (r) => r.partner },
    { label: 'OIB', value: (r) => r.oib },
    { label: 'Vrsta', value: (r) => ACCOUNTANT_KIND_LABEL[r.kind] },
    { label: 'Osnovica', value: (r) => r.net, type: 'money' },
    { label: 'PDV', value: (r) => r.vat, type: 'money' },
    { label: 'Ukupno', value: (r) => r.total, type: 'money' },
    { label: 'Status', value: (r) => r.status },
    { label: 'eRačun', value: (r) => accountantEInvoiceLabel(r.eInvoice) },
    { label: 'Fiskalizacija', value: (r) => (r.fiscal ? FISCAL_STATUS_LABEL[r.fiscal] : '') },
    { label: 'Priloga', value: (r) => r.attachments, type: 'int' },
    { label: 'Poslano knjigovođi', value: (r) => (r.sentAt ? formatDate(r.sentAt.slice(0, 10)) : ''), type: 'date' },
  ];
  return csvOrXlsx(req, list.rows, columns, `knjigovodja-${f.from}-${f.to}`, 'Knjigovođa', {
    companyName: company.name,
    subtitle: `Razdoblje ${formatDate(f.from)} – ${formatDate(f.to)}`,
    landscape: true,
  });
}
