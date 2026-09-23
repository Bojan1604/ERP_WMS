import Link from 'next/link';
import { Download, FileSignature, Plus } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { can } from '@/domain/permissions';
import { getPartnerOptions } from '@/server/queries/lookups';
import { BILLINGS, CONTRACT_STATUSES, listContracts } from '@/server/queries/rentals';
import { BILLING_LABEL, CONTRACT_STATUS_LABEL } from '@/domain/billing';
import { FilterBar, SearchFilter, SelectFilter, ToggleFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { ContractStatusBadge, billingText } from '@/components/rentals/badges';
import { seasonLabel } from '@/domain/plan';
import { date, eur, integer } from '@/lib/format';

export const metadata = { title: 'Ugovori o najmu' };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function ContractsPage({ searchParams }: { searchParams: SP }) {
  const user = await pageAccess('rentals', 'view');
  const params = await searchParams;
  const page = readPage(params, 50);
  const [{ rows, total, summary }, partners] = await Promise.all([
    listContracts(user.companyId, params, page),
    getPartnerOptions(user.companyId, 'customer'),
  ]);
  const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string')).toString();

  return (
    <>
      <PageHeader
        title="Ugovori o najmu"
        subtitle={`${integer(total)} ugovora · ${integer(summary.devices)} uređaja · mjesečno ${eur(summary.monthly)}`}
        actions={
          <>
            <LinkButton href={`/api/najam/ugovori${qs ? `?${qs}` : ''}`} icon={<Download className="size-4" />}>
              CSV
            </LinkButton>
            {can(user.perms, 'rentals', 'edit') && (
              <LinkButton href="/najam/ugovori/novi" variant="primary" icon={<Plus className="size-4" />}>
                Novi ugovor
              </LinkButton>
            )}
          </>
        }
      />
      <FilterBar>
        <SearchFilter placeholder="Broj ugovora ili klijent…" />
        <SelectFilter name="status" placeholder="Svi statusi" options={CONTRACT_STATUSES.map((s) => ({ value: s, label: CONTRACT_STATUS_LABEL[s] }))} />
        <SelectFilter name="partner" placeholder="Svi klijenti" options={partners.map((p) => ({ value: p.id, label: p.name }))} />
        <SelectFilter name="billing" placeholder="Sve naplate" options={BILLINGS.map((b) => ({ value: b, label: BILLING_LABEL[b] }))} />
        <ToggleFilter name="iskljuceni" label="Prikaži isključene partnere" />
      </FilterBar>
      {rows.length ? (
        <TableWrap>
          <table className="data-table">
            <thead>
              <tr>
                <th>Ugovor</th>
                <th>Klijent</th>
                <th>Status</th>
                <th>Početak</th>
                <th>Kraj</th>
                <th>Naplata</th>
                <th className="num">Uređaja</th>
                <th className="num">Mjesečno</th>
                <th>Sljedeća naplata</th>
                <th className="num">Rate za izdati</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link prefetch={false} href={`/najam/ugovori/${c.id}`} className="link whitespace-nowrap font-medium">
                      {c.number}
                    </Link>
                  </td>
                  <td className="max-w-64 truncate">
                    {c.partner.name}
                    {c.partner.excluded && (
                      <Badge className="ml-1.5" tone="warn">
                        isključen
                      </Badge>
                    )}
                  </td>
                  <td>
                    <ContractStatusBadge status={c.status} />
                  </td>
                  <td>{date(c.startDate)}</td>
                  <td>{c.endDate ? date(c.endDate) : <span className="text-fg-3">bez roka</span>}</td>
                  <td className="whitespace-nowrap">
                    {billingText(c.billing, c.billingMode)}
                    {c.seasonFrom ? (
                      <Badge className="ml-1.5" tone="info">
                        {seasonLabel(c.seasonFrom, c.seasonTo)}
                      </Badge>
                    ) : null}
                  </td>
                  <td className="num">{c.devices}</td>
                  <td className="num font-medium">{eur(c.monthly)}</td>
                  <td>{c.nextBilling ? date(c.nextBilling) : <span className="text-fg-3">—</span>}</td>
                  <td className="num">
                    {c.pending ? (
                      <Link prefetch={false} href={`/najam/ugovori/${c.id}`}>
                        <Badge tone="warn">{c.pending}</Badge>
                      </Link>
                    ) : (
                      <span className="text-fg-4">0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <TableWrap>
          <Empty
            icon={<FileSignature className="size-5" />}
            title="Nema ugovora"
            description="Nijedan ugovor ne odgovara filtrima. Isključeni partneri su skriveni dok se ne uključi prekidač."
          />
        </TableWrap>
      )}
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath="/najam/ugovori" />
    </>
  );
}
