import Link from 'next/link';
import { Truck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { listTransfers } from '@/server/queries/warehouse';
import { Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { FilterBar, SearchFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { date } from '@/lib/format';

type Params = Record<string, string | string[] | undefined>;

export default async function TransfersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('warehouse', 'view');
  const sp = await searchParams;
  const pg = readPage(sp, 50);
  const q = typeof sp.q === 'string' && sp.q.trim() ? sp.q.trim() : null;
  const { rows, total } = await listTransfers(user.companyId, pg, q);
  return (
    <>
      <PageHeader title="Međuskladišnice" subtitle="Premještaji uređaja između skladišta — nastaju iz popisa uređaja (Premjesti)" />
      <FilterBar>
        <SearchFilter placeholder="Broj ili serijski broj…" />
      </FilterBar>
      <TableWrap>
        {rows.length ? (
          <table className="data-table sm:min-w-[760px]">
            <thead>
              <tr>
                <th>Broj</th>
                <th>Datum</th>
                <th>Iz skladišta</th>
                <th>U skladište</th>
                <th className="num">Uređaja</th>
                <th>Izradio</th>
                <th>Napomena</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link prefetch={false} href={`/skladiste/medjuskladisnice/${t.id}`} className="link font-medium">
                      {t.number}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap">{date(t.date)}</td>
                  <td>{t.fromWarehouse?.name ?? <span className="text-fg-4">—</span>}</td>
                  <td>{t.toWarehouse.name}</td>
                  <td className="num">{t._count.items}</td>
                  <td>{t.createdBy ?? '—'}</td>
                  <td className="max-w-72 truncate text-fg-3">{t.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon={<Truck className="size-5" />} title={q ? 'Nema međuskladišnica za traženi pojam' : 'Još nema međuskladišnica'} description="Označite uređaje u popisu skladišta i odaberite „Premjesti“." />
        )}
      </TableWrap>
      <Pagination page={pg.page} pageSize={pg.pageSize} total={total} params={sp} basePath="/skladiste/medjuskladisnice" />
    </>
  );
}
