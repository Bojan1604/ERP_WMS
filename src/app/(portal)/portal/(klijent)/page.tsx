import Link from 'next/link';
import { portalPage } from '@/server/portal/auth';
import { listPortalDevices, parsePortalDeviceFilters, portalModels } from '@/server/portal/queries';
import { Badge, Empty, TableWrap } from '@/components/ui/misc';
import { DateRangeFilter, FilterBar, SearchFilter, SelectFilter } from '@/components/ui/filters';
import { ExportButtons } from '@/components/ui/export-buttons';
import { Pagination, readPage } from '@/components/ui/pagination';
import { ReportFaultButton } from '@/components/portal/report-fault';
import { SERVICE_STATUS, type ServiceStatusCode } from '@/components/service/labels';
import { daysUntil, PORTAL_WARRANTY, portalDeviceKind } from '@/domain/portal';
import { queryWithout, type SearchParams } from '@/lib/list-params';
import { date, integer } from '@/lib/format';
import { today } from '@/domain/dates';

export const metadata = { title: 'Moji uređaji' };

/** Uređaji klijenta (u najmu i kupljeni) s jamstvom; prijava kvara uz svaki uređaj. */
export default async function PortalDevicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await portalPage();
  const sp = await searchParams;
  const f = parsePortalDeviceFilters(sp);
  const page = readPage(sp, 50);
  const [{ rows, total, all, stats }, models] = await Promise.all([listPortalDevices(user, f, page), portalModels(user)]);
  const now = today();
  const filtered = total !== all;
  const qs = queryWithout(sp, ['page', 'format']).toString();
  const exportHref = `/portal/api/uredaji${qs ? `?${qs}` : ''}`;

  return (
    <>
      <div className="flex items-start gap-2">
        <FilterBar className="min-w-0 flex-1">
          <SearchFilter placeholder="Naziv ili serijski broj…" />
          <SelectFilter name="model" placeholder="Svi uređaji" options={models} />
          <SelectFilter name="jamstvo" placeholder="Jamstvo: sve" options={Object.entries(PORTAL_WARRANTY).map(([value, label]) => ({ value, label }))} />
          <DateRangeFilter label="Kod vas od" />
        </FilterBar>
        {total > 0 && <ExportButtons href={exportHref} className="no-print shrink-0" />}
      </div>

      {rows.length ? (
        <TableWrap>
          <table className="data-table">
            <thead>
              <tr>
                <th>Uređaj</th>
                <th>Serijski broj</th>
                <th>Vrsta</th>
                <th>Kod vas od</th>
                <th>Jamstvo do</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const name = [d.model.brand, d.model.name].filter(Boolean).join(' ');
                const open = d.serviceOrders[0];
                const inWarranty = !!d.warrantyEnd && d.warrantyEnd >= now;
                return (
                  <tr key={d.id}>
                    <td className="font-medium">{name}</td>
                    <td className="font-mono break-all">{d.serial}</td>
                    <td className="text-fg-2">{portalDeviceKind(d.state, d.status.name)}</td>
                    <td>{date(d.issueDate)}</td>
                    <td>
                      {d.warrantyEnd ? (
                        <Badge tone={inWarranty ? 'ok' : 'neutral'} title={inWarranty ? `još ${daysUntil(d.warrantyEnd, now)} dana` : 'jamstvo isteklo'}>
                          {date(d.warrantyEnd)}
                        </Badge>
                      ) : (
                        <span className="text-fg-4">—</span>
                      )}
                    </td>
                    <td className="text-right">
                      {open ? (
                        <Link prefetch={false} href={`/portal/prijave/${open.id}`} title={`Otvorena prijava ${open.number}`}>
                          <Badge tone="warn">u servisu · {SERVICE_STATUS[open.status as ServiceStatusCode].label}</Badge>
                        </Link>
                      ) : (
                        <ReportFaultButton device={{ id: d.id, name, serial: d.serial, warrantyEnd: d.warrantyEnd, inWarranty }} defaultContact={user.email} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <TableWrap>
          <Empty title="Nema uređaja" description={filtered ? 'Nijedan uređaj ne odgovara filtrima.' : 'Na vaš račun nije vezan nijedan aktivan uređaj.'} />
        </TableWrap>
      )}

      {all > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-2 text-sm text-fg-3">
          <span>
            <b className="text-fg tnum">{integer(total)}</b> {filtered ? `od ${integer(all)} ` : ''}uređaja
          </span>
          <span>najam {integer(stats.rented)}</span>
          <span>kupnja {integer(stats.sold)}</span>
          <span>u jamstvu {integer(stats.inWarranty)}</span>
          <span>u servisu {integer(stats.inService)}</span>
        </div>
      )}
      {total > page.pageSize && <Pagination page={page.page} pageSize={page.pageSize} total={total} params={sp} basePath="/portal" />}
    </>
  );
}
