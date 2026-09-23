import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { can } from '@/domain/permissions';
import { getPartnerOptions } from '@/server/queries/lookups';
import { listQuotes, readQuoteFilters } from '@/server/queries/sales';
import { toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { PageHeader, TableWrap, Empty } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { FilterBar, SearchFilter, SegmentFilter, SelectFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { QuoteBadge, quoteStatus } from '@/components/sales/quote-status';
import { amount, date, integer, pct } from '@/lib/format';

export const metadata = { title: 'Ponude' };

const BASE = '/prodaja/ponude';

export default async function QuotesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await pageAccess('sales', 'view');
  const sp = await searchParams;
  const f = readQuoteFilters(sp);
  const page = readPage(sp, 50);
  const [list, partners] = await Promise.all([listQuotes(user.companyId, f, page), getPartnerOptions(user.companyId, 'customer')]);
  const cur = Number(today().slice(0, 4));

  return (
    <>
      <PageHeader
        title="Ponude"
        subtitle={f.year === 'sve' ? 'Sve godine' : `Godina ${f.year}`}
        actions={
          can(user.perms, 'sales', 'edit') && (
            <LinkButton href={`${BASE}/novi`} variant="primary" icon={<Plus className="size-4" />}>
              Nova ponuda
            </LinkButton>
          )
        }
      />
      <FilterBar>
        <SegmentFilter
          name="godina"
          options={[
            { value: '', label: String(cur) },
            { value: String(cur - 1), label: String(cur - 1) },
            { value: 'sve', label: 'Sve' },
          ]}
        />
        <SearchFilter placeholder="Broj, partner, napomena…" />
        <SelectFilter
          name="status"
          placeholder="Svi statusi"
          options={[
            { value: 'DRAFT', label: 'Nacrt' },
            { value: 'SENT', label: 'Poslana' },
            { value: 'ACCEPTED', label: 'Prihvaćena' },
            { value: 'REJECTED', label: 'Odbijena' },
            { value: 'EXPIRED', label: 'Istekla' },
          ]}
        />
        <SelectFilter name="partner" placeholder="Svi partneri" options={partners.map((p) => ({ value: p.id, label: p.name }))} />
      </FilterBar>

      <TableWrap>
        {list.rows.length === 0 ? (
          <Empty icon={<FileText className="size-5" />} title="Nema ponuda" description="Za zadane filtre nema nijedne ponude." />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Broj</th>
                <th>Datum</th>
                <th>Vrijedi do</th>
                <th>Partner</th>
                <th className="num">Stavki</th>
                <th className="num">Osnovica</th>
                <th className="num">Ukupno</th>
                <th>Status</th>
                <th>Račun</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((q) => {
                const st = quoteStatus(q.status, q.validUntil ? toISO(q.validUntil) : null);
                return (
                  <tr key={q.id}>
                    <td className="whitespace-nowrap font-medium">
                      <Link prefetch={false} href={`${BASE}/${q.id}`} className="link">
                        {q.number}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap">{date(q.date)}</td>
                    <td className={st === 'EXPIRED' ? 'whitespace-nowrap text-warn' : 'whitespace-nowrap text-fg-2'}>{q.validUntil ? date(q.validUntil) : '—'}</td>
                    <td className="max-w-72 truncate">{q.partner.name}</td>
                    <td className="num text-fg-2">{q._count.lines}</td>
                    <td className="num">{amount(num(q.netTotal))}</td>
                    <td className="num font-medium">{amount(num(q.grandTotal))}</td>
                    <td>
                      <QuoteBadge status={st} />
                    </td>
                    <td className="whitespace-nowrap">
                      {q.invoice ? (
                        <Link prefetch={false} href={`/prodaja/racuni/${q.invoice.id}`} className="link">
                          {q.invoice.number ?? 'nacrt'}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}>{integer(list.total)} ponuda</td>
                <td className="num">{amount(list.stats.net)}</td>
                <td className="num">{amount(list.stats.gross)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        )}
      </TableWrap>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-panel px-4 py-2.5 text-sm shadow-[var(--shadow-panel)]">
        <span>
          Ukupno: <b>{integer(list.stats.all)}</b>
        </span>
        <span>
          U tijeku: <b className="text-info">{integer(list.stats.open)}</b>
        </span>
        <span>
          Prihvaćeno: <b className="text-ok">{integer(list.stats.accepted)}</b>
        </span>
        <span>
          Odbijeno: <b className="text-bad-strong">{integer(list.stats.rejected)}</b>
        </span>
        <span>
          Isteklo: <b className="text-warn">{integer(list.stats.expired)}</b>
        </span>
        <span className="ml-auto">
          Uspješnost: <b>{pct(list.stats.rate === null ? null : Math.round(list.stats.rate * 10) / 10)}</b>
        </span>
      </div>
      <Pagination page={page.page} pageSize={page.pageSize} total={list.total} params={sp} basePath={BASE} />
    </>
  );
}
