import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getLookups } from '@/server/queries/lookups';
import { listStocktakes, stocktakeLiveCounts, type StocktakeSummary } from '@/server/queries/stocktake';
import { can } from '@/domain/permissions';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { FilterBar, SelectFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { NewStocktakeButton } from '@/components/warehouse/stocktake-dialogs';
import { date, dateTime, integer } from '@/lib/format';

type Params = Record<string, string | string[] | undefined>;

export default async function StocktakesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('warehouse', 'view');
  const sp = await searchParams;
  const pg = readPage(sp, 30);
  const status = sp.status === 'OPEN' || sp.status === 'CLOSED' ? sp.status : null;
  const [{ rows, total }, lookups] = await Promise.all([listStocktakes(user.companyId, pg, status), getLookups(user.companyId)]);
  // otvorene inventure: brojači iz trenutnih podataka; zatvorene: iz spremljenog sažetka
  const counts = await Promise.all(
    rows.map((r) =>
      r.status === 'OPEN'
        ? stocktakeLiveCounts(db, user.companyId, r)
        : (() => {
            const s = r.summary as unknown as StocktakeSummary | null;
            return { expected: s?.expected ?? 0, found: s?.found ?? 0, missing: s?.missing ?? 0, extra: s?.extra ?? 0, scanned: s?.scanned ?? 0 };
          })(),
    ),
  );
  const canOps = can(user.perms, 'warehouse', 'ops');

  return (
    <>
      <PageHeader
        title="Inventura"
        subtitle="Popis stanja skeniranjem — više ljudi može skenirati istu inventuru s mobitela"
        actions={canOps ? <NewStocktakeButton warehouses={lookups.warehouses.map((w) => ({ value: w.id, label: w.name }))} /> : null}
      />
      <FilterBar>
        <SelectFilter
          name="status"
          placeholder="Sve inventure"
          options={[
            { value: 'OPEN', label: 'U tijeku' },
            { value: 'CLOSED', label: 'Zatvorene' },
          ]}
        />
      </FilterBar>

      {rows.length ? (
        <>
          {/* mobitel: kartice */}
          <ul className="space-y-2 sm:hidden">
            {rows.map((r, i) => (
              <li key={r.id}>
                <Link prefetch={false} href={`/skladiste/inventura/${r.id}`} className="block rounded-lg bg-panel p-3 shadow-[var(--shadow-panel)]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{r.number}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <p className="text-sm text-fg-3">
                    {r.warehouse?.name ?? 'Sva skladišta'} · {date(r.startedAt)}
                    {r.note ? ` · ${r.note}` : ''}
                  </p>
                  <p className="mt-1 text-sm tnum">
                    <span className="text-ok">{integer(counts[i].found)}</span> / {integer(counts[i].expected)} · nedostaje{' '}
                    <span className={counts[i].missing ? 'text-bad-strong' : ''}>{integer(counts[i].missing)}</span> · višak{' '}
                    <span className={counts[i].extra ? 'text-warn' : ''}>{integer(counts[i].extra)}</span>
                  </p>
                </Link>
              </li>
            ))}
          </ul>
          <TableWrap className="max-sm:hidden">
            <table className="data-table no-stack min-w-[900px]">
              <thead>
                <tr>
                  <th>Broj</th>
                  <th>Skladište</th>
                  <th>Status</th>
                  <th className="num">Očekivano</th>
                  <th className="num">Pronađeno</th>
                  <th className="num">Nedostaje</th>
                  <th className="num">Višak</th>
                  <th>Započeta</th>
                  <th>Zatvorena</th>
                  <th>Izradio</th>
                  <th>Napomena</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id}>
                    <td>
                      <Link prefetch={false} href={`/skladiste/inventura/${r.id}`} className="link font-medium">
                        {r.number}
                      </Link>
                    </td>
                    <td>{r.warehouse?.name ?? <span className="text-fg-3">Sva skladišta</span>}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="num">{integer(counts[i].expected)}</td>
                    <td className="num text-ok">{integer(counts[i].found)}</td>
                    <td className={counts[i].missing ? 'num text-bad-strong' : 'num'}>{integer(counts[i].missing)}</td>
                    <td className={counts[i].extra ? 'num text-warn' : 'num'}>{integer(counts[i].extra)}</td>
                    <td className="whitespace-nowrap">{dateTime(r.startedAt)}</td>
                    <td className="whitespace-nowrap">{r.closedAt ? dateTime(r.closedAt) : '—'}</td>
                    <td>{r.createdBy ?? '—'}</td>
                    <td className="max-w-60 truncate text-fg-3">{r.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      ) : (
        <TableWrap>
          <Empty
            icon={<ClipboardCheck className="size-5" />}
            title={status ? 'Nema inventura za zadani filtar' : 'Još nema inventura'}
            description="Započnite inventuru, odaberite skladište i skenirajte uređaje mobitelom ili ručnim čitačem."
          />
        </TableWrap>
      )}
      <Pagination page={pg.page} pageSize={pg.pageSize} total={total} params={sp} basePath="/skladiste/inventura" />
    </>
  );
}

function StatusBadge({ status }: { status: 'OPEN' | 'CLOSED' }) {
  return status === 'OPEN' ? <Badge tone="warn">U tijeku</Badge> : <Badge tone="ok">Zatvorena</Badge>;
}
