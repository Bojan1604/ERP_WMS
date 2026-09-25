import Link from 'next/link';
import { CalendarClock, FileSignature, Paperclip, Plus, Receipt, RotateCcw } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { can } from '@/domain/permissions';
import { getPartnerOptions } from '@/server/queries/lookups';
import { invoiceYears, listInvoices, pendingOut, readInvoiceFilters, unsentCorrections } from '@/server/queries/sales';
import { pendingForCompany } from '@/server/services/rentals';
import { attachmentCounts } from '@/server/services/attachments';
import { paymentState } from '@/domain/invoice';
import { toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { EINVOICE_FILTER, EINVOICE_FILTER_LABEL, EINVOICE_STATUS_LABEL, EINVOICE_STATUS_TONE, type EInvoiceStatusCode } from '@/domain/sales-lines';
import { PageHeader, Notice, TableWrap, Badge, Empty } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { DateRangeFilter, FilterBar, MultiSelectFilter, SearchFilter, SegmentFilter, ToggleFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { FISCAL_STATUS_LABEL, FISCAL_STATUS_TONE } from '@/domain/fiscal';
import { KIND_SHORT, PayBadge, PAY_TONE, rowTone, SortHeader, TYPE_LABEL } from '@/components/sales/list-bits';
import { PendingOutNotice } from '@/components/sales/pending-out';
import { amount, date, eur, integer } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ExportButtons } from '@/components/ui/export-buttons';

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
  const edit = can(user.perms, 'sales', 'edit');
  const [list, partners, years, pendingRent, unsent, out] = await Promise.all([
    listInvoices(user.companyId, f, page),
    getPartnerOptions(user.companyId, 'customer'),
    invoiceYears(user.companyId),
    can(user.perms, 'rentals', 'view') ? pendingRentCount(user.companyId) : Promise.resolve(0),
    unsentCorrections(user.companyId),
    edit ? pendingOut(user.companyId) : Promise.resolve({ total: 0, groups: [] }),
  ]);
  const files = await attachmentCounts(db, user.companyId, 'invoice', list.rows.map((r) => r.id));
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
            <ExportButtons href={`/api/prodaja/racuni/csv?${csv}`} />
            {edit && (
              <LinkButton href={`${BASE}/novi?vrsta=najam`} icon={<FileSignature className="size-4" />}>
                Račun za najam
              </LinkButton>
            )}
            {edit && (
              <LinkButton href={`${BASE}/novi`} variant="primary" icon={<Plus className="size-4" />}>
                Novi račun
              </LinkButton>
            )}
          </>
        }
      />

      {out.total > 0 && (
        <PendingOutNotice
          total={out.total}
          groups={out.groups}
          canRent={can(user.perms, 'rentals', 'edit')}
          canReturn={can(user.perms, 'warehouse', 'ops')}
        />
      )}

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

      {unsent.total > 0 && (
        <Notice tone="warn">
          <b>Nije poslano posredniku:</b> {unsent.total === 1 ? 'dokument' : `${integer(unsent.total)} dokumenata`} (storno / odobrenje) uz već poslane eRačune:{' '}
          {unsent.rows.map((r, i) => (
            <span key={r.id}>
              {i > 0 && ', '}
              <Link prefetch={false} href={`${BASE}/${r.id}`} className="link font-medium">
                {KIND_SHORT[r.kind]} {r.number}
              </Link>
            </span>
          ))}
          {unsent.total > unsent.rows.length && ' …'}. Dok ne stigne posredniku, izvorni račun kod Porezne uprave vrijedi u punom iznosu.
        </Notice>
      )}

      <FilterBar>
        <SegmentFilter
          name="godina"
          options={[{ value: '', label: cur }, ...years.filter((y) => String(y) !== cur).slice(0, 5).map((y) => ({ value: String(y), label: String(y) })), { value: 'sve', label: 'Sve' }]}
        />
        <SearchFilter placeholder="Broj, partner, opis, serijski broj…" />
        {/* na računalu ostali filtri u drugom retku; na mobitelu su svi iza jednog gumba „Filtri" */}
        <div aria-hidden className="h-0 basis-full max-sm:hidden" />
        <MultiSelectFilter name="partner" label="Partner" options={partners.map((p) => ({ value: p.id, label: p.name }))} />
        <MultiSelectFilter
          name="vrsta"
          label="Vrsta"
          options={[
            { value: 'SALE', label: 'Prodaja' },
            { value: 'RENT', label: 'Najam' },
            { value: 'SERVICE', label: 'Usluga' },
          ]}
        />
        <MultiSelectFilter
          name="dokument"
          label="Dokument"
          options={[
            { value: 'INVOICE', label: 'Račun' },
            { value: 'ADVANCE', label: 'Račun za predujam' },
            { value: 'STORNO', label: 'Storno' },
            { value: 'CREDIT_NOTE', label: 'Odobrenje' },
            { value: 'STORNOED', label: 'Stornirani računi' },
          ]}
        />
        <MultiSelectFilter
          name="naplata"
          label="Naplata"
          options={[
            { value: 'open', label: 'Nenaplaćeno (sve)' },
            { value: 'overdue', label: 'Kasni' },
            { value: 'notdue', label: 'Nije dospjelo' },
            { value: 'partial', label: 'Djelomično plaćeno' },
            { value: 'paid', label: 'Plaćeno' },
            { value: 'draft', label: 'Nacrti' },
          ]}
        />
        <MultiSelectFilter name="eracun" label="eRačun" options={EINVOICE_FILTER.map((v) => ({ value: v, label: EINVOICE_FILTER_LABEL[v] }))} />
        <DateRangeFilter label="Datum" />
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
                <th>Opis</th>
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
                <th>Plaćeno</th>
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
                const eStatus = r.eInvoiceStatus as EInvoiceStatusCode | null;
                const unsentCorrection = (r.kind === 'STORNO' || r.kind === 'CREDIT_NOTE') && r.status === 'ISSUED' && !eStatus && !!r.refInvoice?.eInvoiceStatus;
                const nFiles = files.get(r.id) ?? 0;
                return (
                  <tr key={r.id} className={rowTone(st.key)}>
                    <td className="whitespace-nowrap font-medium">
                      <Link prefetch={false} href={href} className="link">
                        {r.refInvoiceId && <span className="mr-1 text-fg-3">↳</span>}
                        {r.number ?? 'Nacrt'}
                      </Link>
                      {r.fiscalStatus !== 'NOT_REQUIRED' && !eStatus && (
                        <Badge tone={FISCAL_STATUS_TONE[r.fiscalStatus]} className="ml-1.5" title={`Fiskalizacija: ${FISCAL_STATUS_LABEL[r.fiscalStatus]}`}>
                          {r.fiscalStatus === 'SENT' ? 'F' : r.fiscalStatus === 'PENDING' ? 'F čeka' : 'F greška'}
                        </Badge>
                      )}
                      {nFiles > 0 && (
                        <span className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-fg-3" title={`Privitaka: ${nFiles}`}>
                          <Paperclip className="size-3" />
                          {nFiles > 1 && nFiles}
                        </span>
                      )}
                    </td>
                    <td className="max-w-56 text-fg-2 max-sm:col-span-2 max-sm:max-w-none">
                      <span className="block truncate max-sm:whitespace-normal" title={r.description ?? undefined}>
                        {r.description || '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap">{date(r.date)}</td>
                    <td className="whitespace-nowrap text-fg-2">{r.dueDate ? date(r.dueDate) : '—'}</td>
                    <td className="max-w-72 max-sm:col-span-2 max-sm:max-w-none">
                      <Link prefetch={false} href={href} className="block truncate hover:underline max-sm:whitespace-normal">
                        {r.partner.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap">
                      {TYPE_LABEL[r.type]}
                      {r.kind !== 'INVOICE' && (
                        <Badge tone={r.kind === 'STORNO' ? 'bad' : 'info'} className="ml-1.5">
                          {KIND_SHORT[r.kind]}
                        </Badge>
                      )}
                      {r.period && (
                        <Badge tone="info" className="ml-1.5" title="Razdoblje najma">
                          {r.period}
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
                      <span className="flex flex-wrap items-center gap-1">
                        <PayBadge state={st} />
                        {eStatus && (
                          <Badge tone={EINVOICE_STATUS_TONE[eStatus]} title={`eRačun: ${EINVOICE_STATUS_LABEL[eStatus]}`}>
                            e: {EINVOICE_STATUS_LABEL[eStatus].toLowerCase()}
                          </Badge>
                        )}
                        {unsentCorrection && (
                          <Badge tone="warn" title="Izvorni račun je poslan posredniku, a ovaj dokument još nije — otvorite ga i pošaljite">
                            nije poslan posredniku
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-sm text-fg-2">
                      {r.paidDate ? date(r.paidDate) : num(r.paidTotal) > 0 ? `${amount(num(r.paidTotal))} / ${amount(num(r.grandTotal))}` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7}>
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
                <td colSpan={3} />
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
