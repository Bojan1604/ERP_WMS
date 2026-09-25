import Link from 'next/link';
import { Plus, Users } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { listPartners, partnerTotals } from '@/server/queries/partners';
import { can } from '@/domain/permissions';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { FilterBar, SearchFilter, SegmentFilter, ToggleFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { eur, integer } from '@/lib/format';
import { ExportButtons } from '@/components/ui/export-buttons';

export const metadata = { title: 'Partneri' };

type Params = Record<string, string | string[] | undefined>;

export default async function PartnersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('partners');
  const params = await searchParams;
  const page = readPage(params, 50);
  // promet, računi i otvoreno pripadaju prodaji
  const canSales = can(user.perms, 'sales');
  const [{ rows, total }, totals] = await Promise.all([
    listPartners(user.companyId, params, page),
    canSales ? partnerTotals(user.companyId, params) : null,
  ]);
  const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'page')).toString();

  return (
    <>
      <PageHeader
        title="Partneri"
        subtitle="Kupci i dobavljači"
        actions={
          <>
            <ExportButtons href={`/api/partneri${qs ? `?${qs}` : ''}`} />
            {can(user.perms, 'partners', 'edit') && (
              <LinkButton href="/partneri/novi" variant="primary" icon={<Plus className="size-4" />}>
                Novi partner
              </LinkButton>
            )}
          </>
        }
      />
      <FilterBar>
        <SearchFilter placeholder="Naziv, OIB, mjesto, e-adresa…" />
        <SegmentFilter
          name="tip"
          options={[
            { value: '', label: 'Svi' },
            { value: 'kupci', label: 'Kupci' },
            { value: 'dobavljaci', label: 'Dobavljači' },
          ]}
        />
        <ToggleFilter name="iskljuceni" label="Samo isključeni iz obračuna" />
      </FilterBar>
      <TableWrap>
        {rows.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Naziv</th>
                <th>OIB</th>
                <th>Mjesto</th>
                <th>E-adresa / telefon</th>
                <th>Uloga</th>
                <th className="num">Uređaja</th>
                <th className="num">Ugovora</th>
                {canSales && (
                  <>
                    <th className="num">Računa</th>
                    <th className="num">Promet</th>
                    <th className="num">Otvoreno</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="max-w-80">
                    <Link prefetch={false} href={`/partneri/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    {p.excluded && (
                      <Badge tone="neutral" className="ml-2" title="Ne ulazi u izvještaje ni nadzornu ploču">
                        isključen
                      </Badge>
                    )}
                    {p.note && (
                      <Badge tone="warn" className="ml-1.5" title={p.note}>
                        napomena
                      </Badge>
                    )}
                  </td>
                  <td className="font-mono text-sm">{p.oib ?? <span className="text-fg-4">—</span>}</td>
                  <td>
                    {p.city ?? <span className="text-fg-4">—</span>}
                    {p.country !== 'HR' && <span className="ml-1.5 text-xs text-fg-3">{p.country}</span>}
                  </td>
                  <td className="max-w-56 text-sm">
                    {p.email ? (
                      <a href={`mailto:${p.email}`} className="link block truncate">
                        {p.email}
                      </a>
                    ) : null}
                    {p.phone ? <span className="block truncate text-fg-3">{p.phone}</span> : null}
                    {!p.email && !p.phone && <span className="text-fg-4">—</span>}
                  </td>
                  <td className="space-x-1 whitespace-nowrap">
                    {p.isCustomer && <Badge tone="brand">kupac</Badge>}
                    {p.isSupplier && <Badge tone="info">dobavljač</Badge>}
                  </td>
                  <td className="num">{p.devices ? integer(p.devices) : <span className="text-fg-4">—</span>}</td>
                  <td className="num">{p.contracts ? integer(p.contracts) : <span className="text-fg-4">—</span>}</td>
                  {canSales && (
                    <>
                      <td className="num">{p.invoices ? integer(p.invoices) : <span className="text-fg-4">—</span>}</td>
                      <td className="num">{p.turnover ? eur(p.turnover) : <span className="text-fg-4">—</span>}</td>
                      <td className="num">{p.open ? <span className="font-medium">{eur(p.open)}</span> : <span className="text-fg-4">—</span>}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon={<Users className="size-5" />} title="Nema partnera" description="Promijenite filtre ili dodajte novog partnera." />
        )}
      </TableWrap>
      {totals && total > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-fg-3">
          <span>
            Partnera: <b className="text-fg">{integer(total)}</b>
          </span>
          <span>
            Promet: <b className="tnum text-fg">{eur(totals.turnover)}</b>
          </span>
          <span>
            Otvoreno: <b className={totals.open > 0 ? 'tnum text-bad-strong' : 'tnum text-fg'}>{eur(totals.open)}</b>
          </span>
          {totals.excluded > 0 && (
            <span>
              Isključeno iz obračuna: <b className="text-fg">{integer(totals.excluded)}</b>
            </span>
          )}
        </div>
      )}
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath="/partneri" />
    </>
  );
}
