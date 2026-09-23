import Link from 'next/link';
import { CalendarClock, Download, Plus, Receipt, RotateCcw } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { can } from '@/domain/permissions';
import { getPartnerOptions } from '@/server/queries/lookups';
import { invoiceYears, listInvoices, readInvoiceFilters } from '@/server/queries/sales';
import { pendingForCompany } from '@/server/services/rentals';
import { paymentState } from '@/domain/invoice';
import { toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { PageHeader, Notice, TableWrap, Badge, Empty } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { DateFilter, FilterBar, SearchFilter, SegmentFilter, SelectFilter, ToggleFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { FISCAL_STATUS_LABEL, FISCAL_STATUS_TONE } from '@/domain/fiscal';
import { KIND_SHORT, PayBadge, PAY_TONE, rowTone, SortHeader, TYPE_LABEL } from '@/components/sales/list-bits';
import { amount, date, eur, integer } from '@/lib/format';
import { cn } from '@/lib/cn';

export const metadata = { title: 'Računi' };

type SP = Record<string, string | string[] | undefined>;
const BASE = '/prodaja/racuni';

async function pendingRentCount(companyId: string) {
  try {
    return (await pendingForCompany(db, companyId)).length;
  } catch (e) {
    console.error('[racuni] rate najma', e);
    return 0;
  }
}

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await pageAccess('sales', 'view');
  const sp = await searchParams;
  const f = readInvoiceFilters(sp);
  const page = readPage(sp, 50);
  const [list, partners, years, pendingRent] = await Promise.all([
    listInvoices(user.companyId, f, page),
    getPartnerOptions(user.companyId, 'customer'),
    invoiceYears(user.companyId),
    can(user.perms, 'rentals', 'view') ? pendingRentCount(user.companyId) : Promise.resolve(0),
  ]);
  const edit = can(user.perms, 'sales', 'edit');
  const csv = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v && k !== 'page') csv.set(k, v);
  const cur = today().slice(0, 4);

  return (
    <>
      <PageHeader
        title="Računi"
        subtitle={f.year === 'sve' ? 'Sve godine' : `Godina ${f.year}`}
        actions={
          <>
            <LinkButton href={`/api/prodaja/racuni/csv?${csv}`} icon={<Download className="size-4" />}>
              Izvoz CSV
            </LinkButton>
            {edit && (
              <LinkButton href={`${BASE}/novi`} variant="primary" icon={<Plus className="size-4" />}>
                Novi račun
              </LinkButton>
            )}
          </>
        }
      />

      {pendingRent > 0 && (
        <Notice
          tone="warn"
          action={
            <LinkButton href="/najam/rate" size="sm" variant="secondary" icon={<CalendarClock className="size-3.5" />}>
              Rate za izdati
            </LinkButton>
          }
        >
          Rate najma čekaju izdavanje: <b>{integer(pendingRent)}</b>
        </Notice>
      )}

      <FilterBar>
        <SegmentFilter
          name="godina"
          options={[{ value: '', label: cur }, ...years.filter((y) => String(y) !== cur).slice(0, 5).map((y) => ({ value: String(y), label: String(y) })), { value: 'sve', label: 'Sve' }]}
        />
        <SearchFilter placeholder="Broj, partner, opis…" />
        {/* na računalu ostali filtri u drugom retku; na mobitelu su svi iza jednog gumba „Filtri" */}
        <div aria-hidden className="h-0 basis-full max-sm:hidden" />
        <SelectFilter name="partner" placeholder="Svi partneri" options={partners.map((p) => ({ value: p.id, label: p.name }))} />
        <SelectFilter
          name="vrsta"
          placeholder="Sve vrste"
          options={[
            { value: 'SALE', label: 'Prodaja' },
            { value: 'RENT', label: 'Najam' },
            { value: 'SERVICE', label: 'Usluga' },
          ]}
        />
        <SelectFilter
          name="dokument"
          placeholder="Svi dokumenti"
          options={[
            { value: 'INVOICE', label: 'Račun' },
            { value: 'ADVANCE', label: 'Račun za predujam' },
            { value: 'STORNO', label: 'Storno' },
            { value: 'CREDIT_NOTE', label: 'Odobrenje' },
            { value: 'STORNOED', label: 'Stornirani računi' },
          ]}
        />
        <SelectFilter
          name="naplata"
          placeholder="Sva stanja"
          options={[
            { value: 'open', label: 'Nenaplaćeno (sve)' },
            { value: 'overdue', label: 'Kasni' },
            { value: 'notdue', label: 'Nije dospjelo' },
            { value: 'partial', label: 'Djelomično plaćeno' },
            { value: 'paid', label: 'Plaćeno' },
            { value: 'draft', label: 'Nacrti' },
          ]}
        />
        <DateFilter name="od" label="Od" />
        <DateFilter name="do" label="Do" />
        <ToggleFilter name="iskljuceni" label="Isključeni partneri" />
        {f.sort && (
          <Link prefetch={false} href={`${BASE}?${new URLSearchParams([...csv.entries()].filter(([k]) => k !== 'sort'))}`} className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
            <RotateCcw className="size-3.5" /> Zadani redoslijed
          </Link>
        )}
      </FilterBar>

      {list.rows.length === 0 ? (
        <TableWrap>
          <Empty icon={<Receipt className="size-5" />} title="Nema računa" description="Za zadane filtre nema nijednog računa." />
        </TableWrap>
      ) : (
        <TableWrap>
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader label="Broj" field="broj" params={sp} basePath={BASE} />
                <SortHeader label="Datum" field="datum" params={sp} basePath={BASE} />
                <SortHeader label="Dospijeće" field="dospijece" params={sp} basePath={BASE} />
                <SortHeader label="Partner" field="partner" params={sp} basePath={BASE} />
                <th>Vrsta</th>
                <th className="num">Uređ.</th>
                <th className="num">Osnovica</th>
                <SortHeader label="Ukupno" field="ukupno" params={sp} basePath={BASE} className="num" />
                <SortHeader label="Otvoreno" field="otvoreno" params={sp} basePath={BASE} className="num" />
                <th className="num">Dana</th>
                <th>Stanje</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => {
                const st = paymentState(
                  {
                    status: r.status,
                    kind: r.kind,
                    stornoed: r.stornoed,
                    date: toISO(r.date),
                    dueDate: r.dueDate ? toISO(r.dueDate) : null,
                    total: num(r.grandTotal),
                    paid: num(r.paidTotal),
                    open: num(r.openAmount),
                    lastPaymentDate: r.paidDate ? toISO(r.paidDate) : null,
                  },
                  list.overdueDays,
                );
                const href = `${BASE}/${r.id}`;
                const counting = r.status === 'ISSUED' && (r.kind === 'INVOICE' || r.kind === 'ADVANCE') && !r.stornoed;
                return (
                  <tr key={r.id} className={rowTone(st.key)}>
                    <td className="whitespace-nowrap font-medium">
                      <Link prefetch={false} href={href} className="link">
                        {r.refInvoiceId && <span className="mr-1 text-fg-3">↳</span>}
                        {r.number ?? 'Nacrt'}
                      </Link>
                      {r.fiscalStatus !== 'NOT_REQUIRED' && (
                        <Badge tone={FISCAL_STATUS_TONE[r.fiscalStatus]} className="ml-1.5" title={`Fiskalizacija: ${FISCAL_STATUS_LABEL[r.fiscalStatus]}`}>
                          {r.fiscalStatus === 'SENT' ? 'F' : r.fiscalStatus === 'PENDING' ? 'F čeka' : 'F greška'}
                        </Badge>
                      )}
                    </td>
                    <td className="whitespace-nowrap">{date(r.date)}</td>
                    <td className="whitespace-nowrap text-fg-2">{r.dueDate ? date(r.dueDate) : '—'}</td>
                    <td className="max-w-72 max-sm:col-span-2 max-sm:max-w-none">
                      <Link prefetch={false} href={href} className="block truncate hover:underline max-sm:whitespace-normal">
                        {r.partner.name}
                      </Link>
                      {r.description && <span className="block truncate text-xs text-fg-3">{r.description}</span>}
                    </td>
                    <td className="whitespace-nowrap">
                      {TYPE_LABEL[r.type]}
                      {r.kind !== 'INVOICE' && (
                        <Badge tone={r.kind === 'STORNO' ? 'bad' : 'info'} className="ml-1.5">
                          {KIND_SHORT[r.kind]}
                        </Badge>
                      )}
                    </td>
                    <td className="num text-fg-2">{r._count.lines || '—'}</td>
                    <td className="num">{amount(num(r.netTotal))}</td>
                    <td className="num font-medium">{amount(num(r.grandTotal))}</td>
                    <td className={cn('num', num(r.openAmount) > 0 && 'font-medium')}>{counting ? amount(num(r.openAmount)) : '—'}</td>
                    <td className="num">
                      {counting ? (
                        <Badge tone={PAY_TONE[st.tone]} title={st.key === 'paid' ? 'Dana do plaćanja' : 'Dana od izdavanja'}>
                          {st.days}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <PayBadge state={st} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}>
                  {integer(list.total)} dokumenata
                  {list.totals.overdueCount > 0 && (
                    <span className="ml-3 font-normal text-bad-strong">
                      kasni {integer(list.totals.overdueCount)} · {eur(list.totals.overdue)}
                    </span>
                  )}
                </td>
                <td className="num">{amount(list.totals.net)}</td>
                <td className="num">{amount(list.totals.issued)}</td>
                <td className="num">{amount(list.totals.open)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </TableWrap>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <FootStat label="Izdano (s PDV-om)" value={eur(list.totals.issued)} />
        <FootStat label="Naplaćeno" value={eur(list.totals.paid)} tone="ok" />
        <FootStat label="Nenaplaćeno" value={eur(list.totals.open)} tone="warn" />
        <FootStat label="Kasni" value={eur(list.totals.overdue)} tone="bad" />
      </div>
      <Pagination page={page.page} pageSize={page.pageSize} total={list.total} params={sp} basePath={BASE} />
    </>
  );
}

function FootStat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-lg bg-panel px-4 py-2.5 shadow-[var(--shadow-panel)]">
      <p className="text-xs text-fg-3">{label}</p>
      <p className={cn('text-md font-semibold tnum', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn', tone === 'bad' && 'text-bad-strong')}>{value}</p>
    </div>
  );
}
