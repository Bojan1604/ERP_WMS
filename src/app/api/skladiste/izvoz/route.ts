import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { exportItems, parseItemFilters } from '@/server/queries/warehouse';
import { modelLabel } from '@/server/queries/lookups';
import { csvResponse, toCsv } from '@/lib/csv';
import { num } from '@/domain/money';
import { formatDate, today } from '@/domain/dates';

/** CSV filtriranih uređaja (isti filtri kao popis skladišta). */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('warehouse', 'view');
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500;
    return new Response(e instanceof Error ? e.message : 'Greška', { status });
  }
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const rows = await exportItems(user.companyId, parseItemFilters(sp));
  type Row = (typeof rows)[number];
  const d = (v: Date | null) => (v ? formatDate(v) : '');
  const csv = toCsv<Row>(rows, [
    { label: 'Serijski broj', value: (r) => r.serial },
    { label: 'Razlikovna napomena', value: (r) => r.dupNote },
    { label: 'Model', value: (r) => modelLabel(r.model) },
    { label: 'Kategorija', value: (r) => r.model.category?.name },
    { label: 'Status', value: (r) => r.status.name },
    { label: 'Skladište', value: (r) => r.warehouse?.name },
    { label: 'Klijent', value: (r) => r.partner?.name },
    { label: 'Dobavljač', value: (r) => r.supplier?.name },
    { label: 'Nabavna cijena', value: (r) => num(r.cost) },
    { label: 'Cijena najma', value: (r) => (r.rentPrice === null ? null : num(r.rentPrice)) },
    { label: 'Datum uvoza', value: (r) => d(r.importDate) },
    { label: 'Datum izdavanja', value: (r) => d(r.issueDate) },
    { label: 'Napomena', value: (r) => r.note },
  ]);
  return csvResponse(csv, `skladiste-${today()}.csv`);
}
