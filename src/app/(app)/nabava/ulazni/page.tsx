import Link from 'next/link';
import { Inbox, Plus } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { listSupplierInvoices, supplierInvoiceYears, supplierOptions } from '@/server/queries/purchasing';
import { getCompany } from '@/server/queries/lookups';
import { can } from '@/domain/permissions';
import { num } from '@/domain/money';
import { today } from '@/domain/dates';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { FilterBar, SearchFilter, SegmentFilter, SelectFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { LinkButton } from '@/components/ui/button';
import { SelectAll, SelectRow, SelectableTr, SelectionProvider } from '@/components/ui/selection';
import { PaidBar } from '@/components/purchasing/paid-bar';
import { FetchEInvoicesButton } from '@/components/purchasing/inbound-actions';
import { SupplierInvoiceSourceBadge, SupplierInvoiceStatusBadge } from '@/components/purchasing/supplier-invoice-badges';
import { date, eur, integer } from '@/lib/format';
import { deleteSupplierInvoicesAction, fetchEInvoicesAction, supplierInvoicesPaidAction } from './actions';
import { vatPctOf } from '@/domain/purchase-links';
import { ExportButtons } from '@/components/ui/export-buttons';

type Params = Record<string, string | string[] | undefined>;
const pctLabel = (v: number | null) => (v === null ? '—' : `${String(v).replace('.', ',')} %`);
const FILTERS = ['q', 'supplier', 'year', 'paid', 'status', 'source'];

export default async function SupplierInvoicesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('purchasing', 'view');
  const sp = await searchParams;
  const pg = readPage(sp, 50);
  const c = user.companyId;
  const [list, years, suppliers, company] = await Promise.all([listSupplierInvoices(c, sp, pg), supplierInvoiceYears(c), supplierOptions(c), getCompany(c)]);
  const canEdit = can(user.perms, 'purchasing', 'edit');
  const hasProvider = !!company.eInvoiceProvider && company.eInvoiceProvider !== 'none';
  const filtered = FILTERS.some((k) => typeof sp[k] === 'string' && sp[k]);
  const t = today();
  const qs = new URLSearchParams();
  for (const k of FILTERS) if (typeof sp[k] === 'string' && sp[k]) qs.set(k, sp[k] as string);

  return (
    <>
      <PageHeader
        title="Ulazni računi"
        subtitle="Knjiga ulaznih računa (URA) · eRačuni od posrednika"
        actions={
          <>
            {canEdit && hasProvider && <FetchEInvoicesButton action={fetchEInvoicesAction} />}
            <ExportButtons href={`/api/nabava/ulazni?${qs}`} />
            {canEdit && (
              <LinkButton href="/nabava/ulazni/novi" variant="primary" icon={<Plus className="size-4" />}>
                Novi ulazni račun
              </LinkButton>
            )}
          </>
        }
      />
      <FilterBar>
        <SearchFilter placeholder="Broj, dobavljač, kategorija…" />
        <SelectFilter name="supplier" placeholder="Svi dobavljači" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
        <SelectFilter name="year" placeholder="Sve godine" options={years.map((y) => ({ value: String(y), label: `${y}.` }))} />
        <SelectFilter
          name="status"
          placeholder="Svi statusi"
          options={[
            { value: 'received', label: 'Zaprimljen' },
            { value: 'accepted', label: 'Prihvaćen' },
            { value: 'rejected', label: 'Odbijen' },
            { value: 'paid', label: 'Plaćen' },
          ]}
        />
        <SelectFilter
          name="source"
          placeholder="Svi izvori"
          options={[
            { value: 'einvoice', label: 'eRačun' },
            { value: 'manual', label: 'Ručno' },
          ]}
        />
        <SegmentFilter
          name="paid"
          options={[
            { value: '', label: 'Svi' },
            { value: 'no', label: 'Neplaćeni' },
            { value: 'yes', label: 'Plaćeni' },
          ]}
        />
        {filtered && (
          <Link prefetch={false} href="/nabava/ulazni" className="text-sm text-fg-3 hover:text-fg">
            Očisti filtre
          </Link>
        )}
      </FilterBar>

      <SelectionProvider ids={list.rows.map((r) => r.id)}>
        {canEdit && <PaidBar action={supplierInvoicesPaidAction} today={t} remove={deleteSupplierInvoicesAction} />}
        <TableWrap>
          {list.rows.length ? (
            <table className="data-table sm:min-w-[1400px]">
              <thead>
                <tr>
                  <th className="w-8">{canEdit && <SelectAll />}</th>
                  <th>Interni br.</th>
                  <th>Broj računa</th>
                  <th>Dobavljač</th>
                  <th>OIB</th>
                  <th>Izvor</th>
                  <th>Datum</th>
                  <th>Dospijeće</th>
                  <th>Kategorija</th>
                  <th className="num">Osnovica</th>
                  <th className="num">PDV</th>
                  <th className="num">PDV %</th>
                  <th className="num">Ukupno</th>
                  <th>Status</th>
                  <th>Plaćeno</th>
                  <th>Trošak</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => {
                  const due = r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null;
                  const rejected = r.status === 'REJECTED';
                  const overdue = !rejected && !r.paidDate && due && due < t;
                  return (
                    <SelectableTr key={r.id} id={r.id}>
                      <td>{canEdit && <SelectRow id={r.id} />}</td>
                      <td>
                        <Link prefetch={false} href={`/nabava/ulazni/${r.id}`} className="link font-medium">
                          {r.internalNo}
                        </Link>
                      </td>
                      <td>
                        {r.number}
                        {(r.orderId || r.receiptId) && <span className="block text-xs text-fg-3">iz nabave</span>}
                      </td>
                      <td>{r.supplier.name}</td>
                      <td className="tnum text-fg-3">{r.supplierOib ?? r.supplier.oib ?? '—'}</td>
                      <td>
                        <SupplierInvoiceSourceBadge source={r.source} />
                      </td>
                      <td className="whitespace-nowrap">{date(r.issueDate)}</td>
                      <td className={overdue ? 'whitespace-nowrap font-medium text-bad-strong' : 'whitespace-nowrap'}>{date(r.dueDate)}</td>
                      <td className="text-fg-3">{r.category ?? '—'}</td>
                      <td className="num">{eur(num(r.netAmount))}</td>
                      <td className="num">{eur(num(r.vatAmount))}</td>
                      <td className="num text-fg-3">{pctLabel(r.vatPct !== null ? num(r.vatPct) : vatPctOf(num(r.netAmount), num(r.vatAmount)))}</td>
                      <td className={rejected ? 'num font-medium text-fg-4 line-through' : 'num font-medium'}>{eur(num(r.total))}</td>
                      <td>
                        <SupplierInvoiceStatusBadge status={r.status} paid={!!r.paidDate} />
                      </td>
                      <td>
                        {rejected ? (
                          <span className="text-fg-4">—</span>
                        ) : r.paidDate ? (
                          <Badge tone="ok">{date(r.paidDate)}</Badge>
                        ) : (
                          <Badge tone={overdue ? 'bad' : 'warn'}>{overdue ? 'dospjelo' : 'nije plaćeno'}</Badge>
                        )}
                      </td>
                      <td>{r.expense ? <Badge tone="info">knjižen</Badge> : <span className="text-fg-4">—</span>}</td>
                    </SelectableTr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td colSpan={8}>
                    {integer(list.total)} računa · neplaćeno {eur(list.sums.unpaid)}
                    {sp.status !== 'rejected' && <span className="text-fg-3"> · zbrojevi bez odbijenih</span>}
                  </td>
                  <td className="num">{eur(list.sums.net)}</td>
                  <td className="num">{eur(list.sums.vat)}</td>
                  <td />
                  <td className="num">{eur(list.sums.total)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          ) : (
            <Empty icon={<Inbox className="size-5" />} title={filtered ? 'Nema računa za zadane filtre' : 'Još nema ulaznih računa'} />
          )}
        </TableWrap>
      </SelectionProvider>
      <Pagination page={pg.page} pageSize={pg.pageSize} total={list.total} params={sp} basePath="/nabava/ulazni" />
    </>
  );
}
