import { getPortalUser } from '@/server/portal/auth';
import { exportPortalDevices, parsePortalDeviceFilters, portalModels } from '@/server/portal/queries';
import { csvOrXlsx } from '@/server/xlsx';
import { SERVICE_STATUS, type ServiceStatusCode } from '@/components/service/labels';
import { PORTAL_WARRANTY, portalDeviceKind, portalDeviceState } from '@/domain/portal';
import { formatDate, today } from '@/domain/dates';

/** Izvoz popisa uređaja klijenta (s filtrima): CSV, Excel (`?format=xlsx`) ili PDF (`?format=pdf`). */
export async function GET(req: Request) {
  const user = await getPortalUser();
  if (!user) return new Response('Niste prijavljeni.', { status: 401 });
  const f = parsePortalDeviceFilters(new URL(req.url).searchParams);
  const [rows, models] = await Promise.all([exportPortalDevices(user, f), f.model ? portalModels(user) : Promise.resolve([])]);
  const now = today();
  const subtitle = [
    user.partnerName,
    `Datum ${formatDate(now)}`,
    f.from || f.to ? `Kod vas od ${f.from ? formatDate(f.from) : '…'} – ${f.to ? formatDate(f.to) : '…'}` : null,
    f.warranty ? PORTAL_WARRANTY[f.warranty] : null,
    f.model ? models.find((m) => m.value === f.model)?.label : null,
    f.q ? `Traženo: ${f.q}` : null,
    `Uređaja: ${rows.length}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return csvOrXlsx(
    req,
    rows,
    [
      { label: 'Uređaj', value: (r) => [r.model.brand, r.model.name].filter(Boolean).join(' ') },
      { label: 'Serijski broj', value: (r) => r.serial, type: 'text' },
      { label: 'Vrsta', value: (r) => portalDeviceKind(r.state, r.status.name) },
      { label: 'Kod vas od', value: (r) => (r.issueDate ? formatDate(r.issueDate) : ''), type: 'date' },
      { label: 'Jamstvo do', value: (r) => (r.warrantyEnd ? formatDate(r.warrantyEnd) : ''), type: 'date' },
      {
        label: 'Stanje',
        value: (r) => portalDeviceState({ openOrderLabel: r.serviceOrders[0] ? SERVICE_STATUS[r.serviceOrders[0].status as ServiceStatusCode].label : null, warrantyEnd: r.warrantyEnd }, now),
      },
    ],
    `uredaji-${now}`,
    'Popis uređaja',
    { subtitle, companyName: user.companyName },
  );
}
