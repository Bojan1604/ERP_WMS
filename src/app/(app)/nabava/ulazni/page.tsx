import Link from 'next/link';
import { Download, Inbox, Plus } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { listSupplierInvoices, supplierInvoiceYears, supplierOptions } from '@/server/queries/purchasing';
import { can } from '@/domain/permissions';
import { num } from '@/domain/money';
import { today } from '@/domain/dates';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { FilterBar, SearchFilter, SegmentFilter, SelectFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { LinkButton, buttonClass } from '@/components/ui/button';
import { SelectAll, SelectRow, SelectableTr, SelectionProvider } from '@/components/ui/selection';
import { PaidBar } from '@/components/purchasing/paid-bar';
import { date, eur, integer } from '@/lib/format';
import { supplierInvoicesPaidAction } from './actions';

type Params = Record<string, string | string[] | undefined>;
const FILTERS = ['q', 'supplier', 'year', 'paid'];

export default async function SupplierInvoicesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('purchasing', 'view');
  const sp = await searchParams;
  const pg = readPage(sp, 50);
  const c = user.companyId;
  const [list, years, suppliers] = await Promise.all([listSupplierInvoices(c, sp, pg), supplierInvoiceYears(c), supplierOptions(c)]);
  const canEdit = can(user.perms, 'purchasing', 'edit');
  const filtered = FILTERS.some((k) => typeof sp[k] === 'string' && sp[k]);
  const t = today();
  const qs = new URLSearchParams();
  for (const k of FILTERS) if (typeof sp[k] === 'string' && sp[k]) qs.set(k, sp[k] as string);

  return (
    <>
      <PageHeader
        title="Ulazni računi"
        subtitle="Knjiga ulaznih računa (URA)"
        actions={
          <>
            <a href={`/api/nabava/ulazni?${qs}`} className={buttonClass('secondary')}>
              <Download className="size-4" /> Izvoz CSV
            </a>
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
        {canEdit && <PaidBar action={supplierInvoicesPaidAction} today={t} />}
        <TableWrap>
          {list.rows.length ? (
            <table className="data-table min-w-[1100px]">
              <thead>
                <tr>
                  <th className="w-8">{canEdit && <SelectAll />}</th>
                  <th>Interni br.</th>
                  <th>Broj računa</th>
                  <th>Dobavljač</th>
                  <th>Datum</th>
                  <th>Dospijeće</th>
                  <th>Kategorija</th>
                  <th className="num">Osnovica</th>
                  <th className="num">PDV</th>
                  <th className="num">Ukupno</th>
                  <th>Plaćeno</th>
                  <th>Trošak</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => {
                  const due = r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null;
                  const overdue = !r.paidDate && due && due < t;
                  return (
                    <SelectableTr key={r.id} id={r.id}>
                      <td>{canEdit && <SelectRow id={r.id} />}</td>
                      <td>
                        <Link prefetch={false} href={`/nabava/ulazni/${r.id}`} className="link font-medium">
                          {r.internalNo}
                        </Link>
                      </td>
                      <td>{r.number}</td>
                      <td>{r.supplier.name}</td>
                      <td className="whitespace-nowrap">{date(r.issueDate)}</td>
                      <td className={overdue ? 'whitespace-nowrap font-medium text-bad-strong' : 'whitespace-nowrap'}>{date(r.dueDate)}</td>
                      <td className="text-fg-3">{r.category ?? '—'}</td>
                      <td className="num">{eur(num(r.netAmount))}</td>
                      <td className="num">{eur(num(r.vatAmount))}</td>
                      <td className="num font-medium">{eur(num(r.total))}</td>
                      <td>{r.paidDate ? <Badge tone="ok">{date(r.paidDate)}</Badge> : <Badge tone={overdue ? 'bad' : 'warn'}>{overdue ? 'dospjelo' : 'nije plaćeno'}</Badge>}</td>
                      <td>{r.expense ? <Badge tone="info">knjižen</Badge> : <span className="text-fg-4">—</span>}</td>
                    </SelectableTr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td colSpan={6}>
                    {integer(list.total)} računa · neplaćeno {eur(list.sums.unpaid)}
                  </td>
                  <td className="num">{eur(list.sums.net)}</td>
                  <td className="num">{eur(list.sums.vat)}</td>
                  <td className="num">{eur(list.sums.total)}</td>
                  <td colSpan={2} />
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
