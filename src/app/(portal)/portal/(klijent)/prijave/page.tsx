import Link from 'next/link';
import { portalPage } from '@/server/portal/auth';
import { listPortalOrders } from '@/server/portal/queries';
import { Badge, Empty, TableWrap } from '@/components/ui/misc';
import { Pagination, readPage } from '@/components/ui/pagination';
import { SERVICE_STATUS, isOpenService, type ServiceStatusCode } from '@/components/service/labels';
import type { SearchParams } from '@/lib/list-params';
import { date } from '@/lib/format';

export const metadata = { title: 'Moje prijave' };

const modelName = (m: { brand: string | null; name: string } | null | undefined) => (m ? [m.brand, m.name].filter(Boolean).join(' ') : '');

/** Servisni nalozi klijenta (prijave s portala i nalozi koje je otvorio servis). */
export default async function PortalOrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await portalPage();
  const sp = await searchParams;
  const page = readPage(sp, 30);
  const { rows, total, open } = await listPortalOrders(user, page);
  if (!total) {
    return (
      <TableWrap>
        <Empty title="Nema prijava" description="Kvar prijavljujete gumbom „Prijavi kvar” uz uređaj na kartici Moji uređaji." />
      </TableWrap>
    );
  }
  return (
    <>
      {open > 0 && <p className="mb-3 text-sm text-fg-3">Otvorenih prijava: <b className="text-fg">{open}</b></p>}
      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th>Broj</th>
              <th>Datum</th>
              <th>Uređaj</th>
              <th>Kvar</th>
              <th>Status</th>
              <th>Zamjenski uređaj</th>
              <th>Rješenje</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const st = SERVICE_STATUS[o.status as ServiceStatusCode];
              return (
                <tr key={o.id}>
                  <td>
                    <Link prefetch={false} href={`/portal/prijave/${o.id}`} className="link font-mono font-medium">
                      {o.number}
                    </Link>
                  </td>
                  <td data-label="Datum">{date(o.reportedAt)}</td>
                  <td data-label="Uređaj">
                    {modelName(o.item?.model)} <span className="font-mono text-fg-3">{o.item?.serial ?? o.serial}</span>
                  </td>
                  <td data-label="Kvar" className="max-w-72 whitespace-pre-line text-fg-2">{o.issue}</td>
                  <td data-label="Status">
                    <Badge tone={isOpenService(o.status) ? 'warn' : 'ok'}>{st.label}</Badge>
                  </td>
                  <td data-label="Zamjenski uređaj">
                    {o.replacement ? (
                      <>
                        <span className="font-mono font-medium break-all">{o.replacement.serial}</span>
                        <span className="block text-xs text-fg-3">{modelName(o.replacement.model)}</span>
                      </>
                    ) : (
                      <span className="text-fg-4">—</span>
                    )}
                  </td>
                  <td data-label="Rješenje" className="text-fg-2">{o.solution || (o.closedAt ? `zatvoreno ${date(o.closedAt)}` : '—')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      {total > page.pageSize && <Pagination page={page.page} pageSize={page.pageSize} total={total} params={sp} basePath="/portal/prijave" />}
    </>
  );
}
