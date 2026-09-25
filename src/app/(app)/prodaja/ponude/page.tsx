import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { can } from '@/domain/permissions';
import { getPartnerOptions } from '@/server/queries/lookups';
import { listQuotes, readQuoteFilters } from '@/server/queries/sales';
import { toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { PageHeader, TableWrap, Empty, Badge } from '@/components/ui/misc';
import { ExportButtons } from '@/components/ui/export-buttons';
import { getCompany } from '@/server/queries/lookups';
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
  const [list, partners, company] = await Promise.all([listQuotes(user.companyId, f, page), getPartnerOptions(user.companyId, 'customer'), getCompany(user.companyId)]);
  const cur = Number(today().slice(0, 4));
  const proformaTitle = company.proformaTitle || 'Predračun';
  const edit = can(user.perms, 'sales', 'edit');
  const csv = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v && k !== 'page') csv.set(k, v);

  return (
    <>
      <PageHeader
        title={f.kind === 'PROFORMA' ? `${proformaTitle} — popis` : 'Ponude'}
        subtitle={f.year === 'sve' ? 'Sve godine' : `Godina ${f.year}`}
        actions={
          <>
            <ExportButtons href={`/api/prodaja/ponude/csv?${csv}`} />
            {edit && (
              <LinkButton href={`${BASE}/novi?vrsta=predracun`} icon={<Plus className="size-4" />}>
                {proformaTitle}
              </LinkButton>
            )}
            {edit && (
              <LinkButton href={`${BASE}/novi`} variant="primary" icon={<Plus className="size-4" />}>
                Nova ponuda
              </LinkButton>
            )}
          </>
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
        <SegmentFilter
          name="vrsta"
          options={[
            { value: '', label: 'Sve' },
            { value: 'QUOTE', label: 'Ponude' },
            { value: 'PROFORMA', label: proformaTitle === 'Predračun' ? 'Predračuni' : proformaTitle },
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
                <th>Opis</th>
                <th>Datum</th>
                <th>Vrijedi do</th>
                <th>Partner</th>
                <th className="num">Stavki</th>
                <th className="num">Osnovica</th>
                <th className="num">Ukupno</th>
                <th>Status</th>
                <th>Račun / ugovor</th>
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
                      {q.kind === 'PROFORMA' && (
                        <Badge tone="info" className="ml-1.5">
                          {proformaTitle.toLowerCase()}
                        </Badge>
                      )}
                    </td>
                    <td className="max-w-56 text-fg-2 max-sm:col-span-2 max-sm:max-w-none">
                      <span className="block truncate max-sm:whitespace-normal" title={q.note ?? undefined}>
                        {q.note || '—'}
                      </span>
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
                      {q.invoice && (
                        <Link prefetch={false} href={`/prodaja/racuni/${q.invoice.id}`} className="link">
                          {q.invoice.number ?? 'nacrt'}
                        </Link>
                      )}
                      {q.contract && (
                        <Link prefetch={false} href={`/najam/ugovori/${q.contract.id}`} className="link ml-1.5">
                          {q.contract.number}
                        </Link>
                      )}
                      {!q.invoice && !q.contract && '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}>{integer(list.total)} dokumenata</td>
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
