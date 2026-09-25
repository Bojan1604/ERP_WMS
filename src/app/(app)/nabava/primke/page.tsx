import Link from 'next/link';
import { PackageCheck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getLookups } from '@/server/queries/lookups';
import { listReceipts, receiptYears } from '@/server/queries/purchasing';
import { partnerOptionsByIds } from '@/server/queries/partner-options';
import { PartnerFilter } from '@/components/partners/partner-combobox';
import { num } from '@/domain/money';
import { canSeeCost } from '@/domain/permissions';
import { ExportButtons } from '@/components/ui/export-buttons';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { FilterBar, SearchFilter, SelectFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { RECEIPT_STATUS } from '@/components/purchasing/labels';
import { date, eur, integer } from '@/lib/format';
import { countLabel } from '@/domain/plural';

type Params = Record<string, string | string[] | undefined>;

export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('purchasing', 'view');
  const sp = await searchParams;
  const pg = readPage(sp, 50);
  const c = user.companyId;
  const [list, years, suppliers, lookups] = await Promise.all([listReceipts(c, sp, pg), receiptYears(c), partnerOptionsByIds(c, [typeof sp.supplier === 'string' ? sp.supplier : null]), getLookups(c)]);
  const filtered = ['q', 'status', 'supplier', 'warehouse', 'year'].some((k) => typeof sp[k] === 'string' && sp[k]);
  const costs = canSeeCost(user.perms);
  const qs = new URLSearchParams();
  for (const k of ['q', 'status', 'supplier', 'warehouse', 'year']) if (typeof sp[k] === 'string' && sp[k]) qs.set(k, sp[k] as string);

  return (
    <>
      <PageHeader title="Primke" subtitle="Zaprimljena roba po dokumentima — iz narudžbenica i skupnog zaprimanja na skladištu" actions={<ExportButtons href={`/api/nabava/primke?${qs}`} />} />
      <FilterBar>
        <SearchFilter placeholder="Broj, dobavljač, serijski broj…" />
        <PartnerFilter name="supplier" role="supplier" placeholder="Svi dobavljači" current={suppliers[0] ?? null} />
        <SelectFilter name="warehouse" placeholder="Sva skladišta" options={lookups.warehouses.map((w) => ({ value: w.id, label: w.name }))} />
        <SelectFilter name="status" placeholder="Sve primke" options={[{ value: 'POSTED', label: 'Proknjižene' }, { value: 'CANCELLED', label: 'Stornirane' }]} />
        <SelectFilter name="year" placeholder="Sve godine" options={years.map((y) => ({ value: String(y), label: `${y}.` }))} />
        {filtered && (
          <Link prefetch={false} href="/nabava/primke" className="text-sm text-fg-3 hover:text-fg">
            Očisti filtre
          </Link>
        )}
      </FilterBar>
      <TableWrap>
        {list.rows.length ? (
          <table className="data-table sm:min-w-[1000px]">
            <thead>
              <tr>
                <th>Broj</th>
                <th>Datum</th>
                <th>Dobavljač</th>
                <th>Dokument dobavljača</th>
                <th>Skladište</th>
                <th>Narudžbenica</th>
                <th className="num">Kom</th>
                {costs && <th className="num">Iznos</th>}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id} className={r.status === 'CANCELLED' ? 'text-fg-3' : undefined}>
                  <td>
                    <Link prefetch={false} href={`/nabava/primke/${r.id}`} className="link font-medium">
                      {r.number}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap">{date(r.date)}</td>
                  <td>{r.supplier?.name ?? '—'}</td>
                  <td>{r.supplierDocNumber ?? '—'}</td>
                  <td>{r.warehouse.name}</td>
                  <td>
                    {r.order ? (
                      <Link prefetch={false} href={`/nabava/narudzbenice/${r.order.id}`} className="link">
                        {r.order.number}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">{integer(r._count.items)}</td>
                  {costs && <td className="num">{r.status === 'CANCELLED' ? <s>{eur(num(r.total))}</s> : eur(num(r.total))}</td>}
                  <td>
                    <Badge tone={RECEIPT_STATUS[r.status].tone}>{RECEIPT_STATUS[r.status].label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7}>Ukupno: {countLabel(list.total, 'primka', 'primke', 'primki', integer)} (iznos bez storniranih)</td>
                {costs && <td className="num">{eur(list.sum)}</td>}
                <td />
              </tr>
            </tfoot>
          </table>
        ) : (
          <Empty icon={<PackageCheck className="size-5" />} title={filtered ? 'Nema primki za zadane filtre' : 'Još nema primki'} description="Primka nastaje zaprimanjem robe po narudžbenici ili na skladištu." />
        )}
      </TableWrap>
      <Pagination page={pg.page} pageSize={pg.pageSize} total={list.total} params={sp} basePath="/nabava/primke" />
    </>
  );
}
