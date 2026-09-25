import { requireAccess } from '@/server/auth';
import { listOrders } from '@/server/queries/purchasing';
import { csvOrXlsx } from '@/server/xlsx';
import type { ExportColumn } from '@/lib/csv';
import { ORDER_STATUS } from '@/components/purchasing/labels';
import { canSeeCost } from '@/domain/permissions';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { date } from '@/lib/format';

/** Narudžbenice u CSV-u, Excelu ili PDF-u — isti filtri kao popis. */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('purchasing', 'view');
  } catch {
    return new Response('Nemate pravo pristupa.', { status: 403 });
  }
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const { rows } = await listOrders(user.companyId, sp, { skip: 0, take: 20_000 });
  type Row = (typeof rows)[number];
  const cols: Array<ExportColumn<Row> & { cost?: boolean }> = [
    { label: 'Broj', value: (r) => r.number },
    { label: 'Datum', value: (r) => date(r.date), type: 'date' },
    { label: 'Dobavljač', value: (r) => r.supplier.name },
    { label: 'Očekivano', value: (r) => (r.expectedDate ? date(r.expectedDate) : ''), type: 'date' },
    { label: 'Status', value: (r) => ORDER_STATUS[r.status].label },
    { label: 'Naručeno', value: (r) => r.lines.reduce((a, l) => a + l.qty, 0), type: 'int' },
    { label: 'Zaprimljeno', value: (r) => r.lines.reduce((a, l) => a + l.received, 0), type: 'int' },
    { label: 'Vrijednost €', value: (r) => num(r.total), type: 'money', cost: true },
  ];
  const costs = canSeeCost(user.perms);
  return csvOrXlsx(req, rows, cols.filter((c) => costs || !c.cost), `narudzbenice-${toISO(new Date())}`, 'Narudžbenice');
}
