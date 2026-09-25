import Link from 'next/link';
import { FileSignature, Paperclip, Plus } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { can } from '@/domain/permissions';
import { getPartnerOptions } from '@/server/queries/lookups';
import { BILLINGS, CONTRACT_STATUSES, EXPIRING_DAYS, listContracts } from '@/server/queries/contract-list';
import { BILLING_LABEL, CONTRACT_STATUS_LABEL } from '@/domain/billing';
import { FilterBar, MultiSelectFilter, SearchFilter, SegmentFilter, ToggleFilter } from '@/components/ui/filters';
import { SortHeader } from '@/components/ui/sort-header';
import { Pagination, readPage } from '@/components/ui/pagination';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { ContractStatusBadge, billingText } from '@/components/rentals/badges';
import { seasonLabel } from '@/domain/plan';
import { date, eur, integer } from '@/lib/format';
import { ExportButtons } from '@/components/ui/export-buttons';
import { queryWithout } from '@/lib/list-params';

export const metadata = { title: 'Ugovori o najmu' };

type SP = Promise<Record<string, string | string[] | undefined>>;

const BASE = '/najam/ugovori';

export default async function ContractsPage({ searchParams }: { searchParams: SP }) {
  const user = await pageAccess('rentals', 'view');
  const params = await searchParams;
  const page = readPage(params, 50);
  const [{ rows, total, summary }, partners] = await Promise.all([
    listContracts(user.companyId, params, page),
    getPartnerOptions(user.companyId, 'customer'),
  ]);
  const qs = queryWithout(params).toString();
  const y = summary.year;

  return (
    <>
      <PageHeader
        title="Ugovori o najmu"
        subtitle={`${integer(total)} ugovora · ${integer(summary.devices)} uređaja · mjesečno (aktivni) ${eur(summary.monthly)}`}
        actions={
          <>
            <ExportButtons href={`/api/najam/ugovori${qs ? `?${qs}` : ''}`} />
            {can(user.perms, 'rentals', 'edit') && (
              <LinkButton href="/najam/ugovori/novi" variant="primary" icon={<Plus className="size-4" />}>
                Novi ugovor
              </LinkButton>
            )}
          </>
        }
      />
      <FilterBar>
        <SegmentFilter
          name="pogled"
          options={[
            { value: '', label: 'Aktivni' },
            { value: 'sezonski', label: 'Sezonski' },
            { value: 'istek', label: 'Uskoro istječu' },
            { value: 'svi', label: 'Svi' },
          ]}
        />
        <SearchFilter placeholder="Broj ugovora ili klijent…" />
        <MultiSelectFilter name="status" label="Status" options={CONTRACT_STATUSES.map((s) => ({ value: s, label: CONTRACT_STATUS_LABEL[s] }))} />
        <MultiSelectFilter name="partner" label="Klijent" options={partners.map((p) => ({ value: p.id, label: p.name }))} />
        <MultiSelectFilter name="billing" label="Naplata" options={BILLINGS.map((b) => ({ value: b, label: BILLING_LABEL[b] }))} />
        <ToggleFilter name="iskljuceni" label="Prikaži isključene partnere" />
      </FilterBar>
      {rows.length ? (
        <TableWrap>
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader label="Ugovor" field="broj" params={params} basePath={BASE} />
                <SortHeader label="Klijent" field="klijent" params={params} basePath={BASE} />
                <th>Status</th>
                <SortHeader label="Početak" field="pocetak" params={params} basePath={BASE} defaultDir="desc" />
                <SortHeader label="Kraj" field="kraj" params={params} basePath={BASE} />
                <th>Naplata</th>
                <th className="num">Uređaja</th>
                <th className="num">Mjesečno</th>
                <th className="num">Rata</th>
                <th className="num">Obračun {y}.</th>
                <th className="num">Naplata {y}.</th>
                <th>Sljedeća naplata</th>
                <th className="num">Rate za izdati</th>
                <th>PDF</th>
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
                  <td className="whitespace-nowrap">
                    {c.endDate ? date(c.endDate) : <span className="text-fg-3">bez roka</span>}
                    {c.endsIn !== null && c.endsIn >= 0 && c.endsIn < EXPIRING_DAYS && (
                      <Badge className="ml-1.5" tone="warn" title="Dana do isteka ugovora">
                        {c.endsIn} d
                      </Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {billingText(c.billing, c.billingMode)}
                    {c.seasonFrom ? (
                      <Badge className="ml-1.5" tone="info">
                        {seasonLabel(c.seasonFrom, c.seasonTo)}
                      </Badge>
                    ) : null}
                    {c.custom > 0 && (
                      <Badge className="ml-1.5" tone="warn" title="Uređaji s vlastitim uvjetima naplate">
                        +{c.custom}
                      </Badge>
                    )}
                  </td>
                  <td className="num">{c.devices}</td>
                  <td className="num font-medium">{eur(c.monthly)}</td>
                  <td className="num">{c.installment !== null ? eur(c.installment) : <span className="text-fg-3">razno</span>}</td>
                  <td className="num">{c.accrual ? eur(c.accrual) : <span className="text-fg-4">—</span>}</td>
                  <td className="num">{c.billed ? eur(c.billed) : <span className="text-fg-4">—</span>}</td>
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
                  <td>
                    {c.pdf ? (
                      <Link prefetch={false} href={`/najam/ugovori/${c.id}?tab=pdf`} title="Priloženi ugovor">
                        <Badge tone="info">
                          <Paperclip className="mr-0.5 inline size-3" />
                          PDF
                        </Badge>
                      </Link>
                    ) : (
                      <span className="text-fg-4">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}>{integer(total)} ugovora</td>
                <td className="num">{integer(summary.devices)}</td>
                <td className="num" title="Zbroj stupca za sve ugovore filtra">
                  {eur(summary.monthlyAll)}
                </td>
                <td />
                <td className="num">{eur(summary.accrual)}</td>
                <td className="num">{eur(summary.billed)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
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
      {rows.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-fg-3">
          <span>
            Mjesečno (aktivni): <b className="tnum text-fg">{eur(summary.monthly)}</b>
          </span>
          <span>
            Obračun {y}.: <b className="tnum text-fg">{eur(summary.accrual)}</b>
          </span>
          <span>
            Naplata {y}.: <b className="tnum text-fg">{eur(summary.billed)}</b>
          </span>
          {summary.custom > 0 && (
            <span>
              Uređaja s vlastitim uvjetima: <b className="text-warn">{integer(summary.custom)}</b>
            </span>
          )}
          <span>
            Sezonskih: <b className="text-fg">{integer(summary.seasonal)}</b>
          </span>
          <span>
            Istječe &lt; {EXPIRING_DAYS} d: <b className={summary.expiring ? 'text-warn' : 'text-fg'}>{integer(summary.expiring)}</b>
          </span>
        </div>
      )}
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath={BASE} />
    </>
  );
}
