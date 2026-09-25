import { requireAccess } from '@/server/auth';
import { listReceipts } from '@/server/queries/purchasing';
import { csvOrXlsx } from '@/server/xlsx';
import type { ExportColumn } from '@/lib/csv';
import { RECEIPT_STATUS } from '@/components/purchasing/labels';
import { canSeeCost } from '@/domain/permissions';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { date } from '@/lib/format';

/** Primke u CSV-u, Excelu ili PDF-u — isti filtri kao popis. */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('purchasing', 'view');
  } catch {
    return new Response('Nemate pravo pristupa.', { status: 403 });
  }
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const { rows } = await listReceipts(user.companyId, sp, { skip: 0, take: 20_000 });
  type Row = (typeof rows)[number];
  const cols: Array<ExportColumn<Row> & { cost?: boolean }> = [
    { label: 'Broj', value: (r) => r.number },
    { label: 'Datum', value: (r) => date(r.date), type: 'date' },
    { label: 'Dobavljač', value: (r) => r.supplier?.name },
    { label: 'Narudžbenica', value: (r) => r.order?.number },
    { label: 'Skladište', value: (r) => r.warehouse.name },
    { label: 'Dokument dobavljača', value: (r) => r.supplierDocNumber },
    { label: 'Komada', value: (r) => r._count.items, type: 'int' },
    { label: 'Vrijednost €', value: (r) => num(r.total), type: 'money', cost: true },
    { label: 'Status', value: (r) => RECEIPT_STATUS[r.status].label },
  ];
  const costs = canSeeCost(user.perms);
  return csvOrXlsx(req, rows, cols.filter((c) => costs || !c.cost), `primke-${toISO(new Date())}`, 'Primke');
}
