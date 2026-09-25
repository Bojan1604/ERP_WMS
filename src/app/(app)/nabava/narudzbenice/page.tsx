import Link from 'next/link';
import { ClipboardList, Plus, TriangleAlert } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { listOrders, lowStock, orderYears, supplierOptions } from '@/server/queries/purchasing';
import { modelLabel } from '@/server/queries/lookups';
import { can, canSeeCost } from '@/domain/permissions';
import { ExportButtons } from '@/components/ui/export-buttons';
import { num } from '@/domain/money';
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { FilterBar, SearchFilter, SelectFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { LinkButton, buttonClass } from '@/components/ui/button';
import { ORDER_STATUS, type OrderStatusCode } from '@/components/purchasing/labels';
import { date, eur, integer } from '@/lib/format';

type Params = Record<string, string | string[] | undefined>;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('purchasing', 'view');
  const sp = await searchParams;
  const pg = readPage(sp, 50);
  const c = user.companyId;
  const [list, low, years, suppliers] = await Promise.all([listOrders(c, sp, pg), lowStock(c), orderYears(c), supplierOptions(c)]);
  const canEdit = can(user.perms, 'purchasing', 'edit');
  const filtered = ['q', 'status', 'supplier', 'year'].some((k) => typeof sp[k] === 'string' && sp[k]);
  const toOrder = low.filter((m) => m.missing > 0);
  const costs = canSeeCost(user.perms);
  // narudžbenica su nabavne cijene — upis i izmjena samo uz pravo na nabavne cijene (costs)
  const canCreate = canEdit && costs;
  const qs = new URLSearchParams();
  for (const k of ['q', 'status', 'supplier', 'year']) if (typeof sp[k] === 'string' && sp[k]) qs.set(k, sp[k] as string);
  const prefill = (rows: typeof low) => `/nabava/narudzbenice/novi?lines=${rows.map((m) => `${m.id}:${Math.max(1, m.missing)}`).join(',')}`;

  return (
    <>
      <PageHeader
        title="Narudžbenice"
        subtitle="Narudžbe robe od dobavljača"
        actions={
          <>
            <ExportButtons href={`/api/nabava/narudzbenice?${qs}`} />
            {canCreate && (
              <LinkButton href="/nabava/narudzbenice/novi" variant="primary" icon={<Plus className="size-4" />}>
                Nova narudžbenica
              </LinkButton>
            )}
          </>
        }
      />

      {low.length > 0 && (
        <Card
          className="mb-4"
          title={
            <span className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-warn" /> Niska zaliha
            </span>
          }
          actions={
            canCreate &&
            toOrder.length > 0 && (
              <LinkButton href={prefill(toOrder)} size="sm" variant="subtle">
                Naruči sve što nedostaje ({toOrder.length})
              </LinkButton>
            )
          }
          padded={false}
        >
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Minimum</th>
                <th className="num">Na skladištu</th>
                <th className="num">Naručeno, nije stiglo</th>
                <th className="num">Nedostaje</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {low.map((m) => (
                <tr key={m.id}>
                  <td>{modelLabel(m)}</td>
                  <td className="num">{m.minStock}</td>
                  <td className="num font-medium text-bad-strong">{m.inStock}</td>
                  <td className="num">{m.onOrder || '—'}</td>
                  <td className="num">{m.missing ? <b>{m.missing}</b> : <span className="text-ok">pokriveno narudžbom</span>}</td>
                  <td className="num">
                    {canCreate && m.missing > 0 && (
                      <Link prefetch={false} href={prefill([m])} className="link text-sm">
                        Naruči
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <FilterBar>
        <SearchFilter placeholder="Broj, dobavljač, model, napomena…" />
        <SelectFilter
          name="status"
          placeholder="Svi statusi"
          options={[{ value: 'open', label: 'Otvorene (čeka robu)' }, ...Object.entries(ORDER_STATUS).map(([value, s]) => ({ value, label: s.label }))]}
        />
        <SelectFilter name="supplier" placeholder="Svi dobavljači" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
        <SelectFilter name="year" placeholder="Sve godine" options={years.map((y) => ({ value: String(y), label: `${y}.` }))} />
        {filtered && (
          <Link prefetch={false} href="/nabava/narudzbenice" className="text-sm text-fg-3 hover:text-fg">
            Očisti filtre
          </Link>
        )}
      </FilterBar>

      <TableWrap>
        {list.rows.length ? (
          <table className="data-table sm:min-w-[900px]">
            <thead>
              <tr>
                <th>Broj</th>
                <th>Datum</th>
                <th>Dobavljač</th>
                <th>Očekivano</th>
                <th className="num">Zaprimljeno / naručeno</th>
                {costs && <th className="num">Iznos</th>}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((o) => {
                const qty = o.lines.reduce((a, l) => a + l.qty, 0);
                const rec = o.lines.reduce((a, l) => a + l.received, 0);
                const st = ORDER_STATUS[o.status as OrderStatusCode];
                return (
                  <tr key={o.id}>
                    <td>
                      <Link prefetch={false} href={`/nabava/narudzbenice/${o.id}`} className="link font-medium">
                        {o.number}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap">{date(o.date)}</td>
                    <td>{o.supplier.name}</td>
                    <td className="whitespace-nowrap">{date(o.expectedDate)}</td>
                    <td className="num">
                      {integer(rec)} / {integer(qty)}
                    </td>
                    {costs && <td className="num">{eur(num(o.total))}</td>}
                    <td>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}>Ukupno: {integer(list.total)} narudžbenica</td>
                {costs && <td className="num">{eur(list.sum)}</td>}
                <td />
              </tr>
            </tfoot>
          </table>
        ) : (
          <Empty
            icon={<ClipboardList className="size-5" />}
            title={filtered ? 'Nema narudžbenica za zadane filtre' : 'Još nema narudžbenica'}
            action={
              canCreate && !filtered ? (
                <Link prefetch={false} href="/nabava/narudzbenice/novi" className={buttonClass('primary')}>
                  Nova narudžbenica
                </Link>
              ) : undefined
            }
          />
        )}
      </TableWrap>
      <Pagination page={pg.page} pageSize={pg.pageSize} total={list.total} params={sp} basePath="/nabava/narudzbenice" />
    </>
  );
}
