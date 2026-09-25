import { requireAccess } from '@/server/auth';
import { listServiceOrders } from '@/server/queries/service';
import { modelLabel } from '@/server/queries/lookups';
import { daysBetween, toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { SERVICE_STATUS } from '@/components/service/labels';
import { csvOrXlsx } from '@/server/xlsx';
import { date } from '@/lib/format';

/** Servisni nalozi u CSV-u ili Excelu — isti filtri kao popis. */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('service', 'view');
  } catch {
    return new Response('Nemate pravo pristupa.', { status: 403 });
  }
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const { rows } = await listServiceOrders(user.companyId, sp, { skip: 0, take: 20_000 });
  const t = today();
  return csvOrXlsx(
    req,
    rows,
    [
    { label: 'Broj', value: (r) => r.number },
    { label: 'Serijski broj', value: (r) => r.serial },
    { label: 'Model', value: (r) => (r.item ? modelLabel(r.item.model) : '') },
    { label: 'Klijent', value: (r) => r.partner?.name },
    { label: 'Račun', value: (r) => r.invoice?.number },
    { label: 'Izvor', value: (r) => (r.source === 'PORTAL' ? 'portal' : '') },
    { label: 'Status', value: (r) => SERVICE_STATUS[r.status].label },
    { label: 'Prijavljeno', value: (r) => date(r.reportedAt) },
    { label: 'Zaprimljeno', value: (r) => (r.receivedAt ? date(r.receivedAt) : '') },
    { label: 'Kvar', value: (r) => r.issue },
    { label: 'Dijagnoza', value: (r) => r.diagnosis },
    { label: 'Akcija', value: (r) => r.action },
    { label: 'Rješenje', value: (r) => r.solution },
    { label: 'Zamjenski', value: (r) => r.replacement?.serial },
    { label: 'Trošak', value: (r) => num(r.cost), type: 'money' },
    { label: 'Jamstvo', value: (r) => (r.underWarranty ? 'da' : 'ne') },
    { label: 'Zatvoreno', value: (r) => (r.closedAt ? date(r.closedAt) : '') },
    { label: 'Dana', value: (r) => daysBetween(toISO(r.reportedAt), r.closedAt ? toISO(r.closedAt) : t), type: 'int' },
  ],
    `servis-${t}`,
    'Servis',
    { landscape: true },
  );
}
