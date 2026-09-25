import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { attachmentCounts } from '@/server/services/attachments';
import { getCompany, getLookups } from '@/server/queries/lookups';
import { expensesForYear, expenseYears, parseExpenseFilters } from '@/server/queries/expenses';
import { partnerOptionsByIds } from '@/server/queries/partner-options';
import { PartnerFilter } from '@/components/partners/partner-combobox';
import { can } from '@/domain/permissions';
import { MONTHS_HR } from '@/domain/dates';
import { num } from '@/domain/money';
import { Card, PageHeader, Stat, TableWrap } from '@/components/ui/misc';
import { Pagination, readPage } from '@/components/ui/pagination';
import { FilterBar, SearchFilter, SegmentFilter, SelectFilter } from '@/components/ui/filters';
import { ExpensesTable, NewExpenseButton } from '@/components/expenses/expenses-table';
import { CategoriesDialog } from '@/components/expenses/categories-dialog';
import { CategorySummary, MonthSummary } from '@/components/expenses/summaries';
import { EXPENSE_SOURCE } from '@/components/expenses/labels';
import { cn } from '@/lib/cn';
import { eur } from '@/lib/format';
import { deleteExpenseAction, expensesPaidAction, saveCategoryAction, saveExpenseAction, saveOccurrenceAction } from './actions';
import { ExportButtons } from '@/components/ui/export-buttons';

type Params = Record<string, string | string[] | undefined>;
const FILTERS = ['month', 'category', 'partner', 'q', 'paid', 'source'];

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('expenses', 'view');
  const sp = await searchParams;
  const f = parseExpenseFilters(sp);
  const c = user.companyId;
  // tablica po stranicama (zbrojevi i grafovi su preko cijele godine, izvoz sadrži sve)
  const pg = readPage(sp, 100);
  const [data, years, lookups, company] = await Promise.all([expensesForYear(c, f, pg), expenseYears(c), getLookups(c), getCompany(c)]);
  // partneri: samo oni na prikazanim ručnim troškovima i u filtru — ostali se u odabiru traže pretragom
  const partners = await partnerOptionsByIds(c, [...Object.values(data.manual).map((m) => m.partnerId), f.partnerId]);
  const canEdit = can(user.perms, 'expenses', 'edit');
  // oznaka priloga u tablici — jedan groupBy za prikazane troškove
  const attachments = Object.fromEntries(await attachmentCounts(db, c, 'expense', [...new Set(data.rows.map((r) => r.expenseId))]));

  const href = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v) q.set(k, v);
    for (const [k, v] of Object.entries(patch)) (v ? q.set(k, v) : q.delete(k));
    q.delete('page');
    const s = q.toString();
    return s ? `/troskovi?${s}` : '/troskovi';
  };
  const qs = new URLSearchParams({ year: String(f.year) });
  for (const k of FILTERS) if (typeof sp[k] === 'string' && sp[k]) qs.set(k, sp[k] as string);
  const filtered = FILTERS.some((k) => typeof sp[k] === 'string' && sp[k]);

  const options = {
    categories: lookups.expenseCategories.map((x) => ({ value: x.id, label: x.name })),
    partners,
    company: { vatRate: num(company.vatRate), country: company.country },
  };
  const actions = { save: saveExpenseAction, remove: deleteExpenseAction, occurrence: saveOccurrenceAction };
  const t = data.totals;

  return (
    <>
      <PageHeader
        title="Troškovi"
        subtitle={`Godina ${f.year}.${f.month ? ` · ${MONTHS_HR[f.month - 1]}` : ''} — iznosi bez PDV-a osim gdje piše drukčije`}
        actions={
          <>
            <ExportButtons href={`/api/troskovi?${qs}`} />
            {canEdit && <CategoriesDialog categories={lookups.expenseCategories} action={saveCategoryAction} />}
            {canEdit && <NewExpenseButton options={options} actions={actions} />}
          </>
        }
      />

      <div className="no-print mb-3 flex flex-wrap gap-1.5">
        {years.map((y) => (
          <Link prefetch={false} key={y} href={href({ year: String(y), month: null })} className={chip(y === f.year)}>
            {y}.
          </Link>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <Stat label="Troškovi (neto)" value={eur(t.net)} />
        <Stat label="PDV (pretporez)" value={eur(t.vat)} />
        <Stat label="Ukupno s PDV-om" value={eur(Math.round((t.net + t.vat) * 100) / 100)} />
        <Stat label="Nije plaćeno (s PDV-om)" value={eur(t.unpaid)} tone={t.unpaid ? 'warn' : undefined} />
        <Stat label="Iz nabave (primke)" value={eur(t.purchase)} />
        <Stat label="Planirano do kraja godine" value={eur(t.planned)} hint={`Ponavljajući: ${eur(t.recurringMonthly)} mjesečno`} />
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-[1fr_400px]">
        <Card title="Po mjesecima" className="min-w-0" actions={<span className="text-xs text-fg-3">klik na mjesec filtrira · iscrtkano = planirano</span>}>
          <MonthSummary booked={data.byMonth} planned={data.plannedByMonth} activeMonth={f.month} monthHref={(m) => href({ month: m ? String(m) : null })} />
        </Card>
        <Card title="Po kategorijama" padded={false} className="max-h-72 overflow-y-auto scroll-slim">
          <CategorySummary rows={data.byCategory} total={t.net} />
        </Card>
      </div>

      <FilterBar>
        <SearchFilter placeholder="Opis, partner, napomena…" />
        <SelectFilter name="month" placeholder="Svi mjeseci" options={MONTHS_HR.map((m, i) => ({ value: String(i + 1), label: m }))} />
        <SelectFilter name="category" placeholder="Sve kategorije" options={options.categories} />
        <PartnerFilter role="expense" placeholder="Svi partneri" current={partners.find((p) => p.id === f.partnerId) ?? null} />
        <SelectFilter name="source" placeholder="Svi izvori" options={Object.entries(EXPENSE_SOURCE).map(([value, s]) => ({ value, label: s.label }))} />
        <SegmentFilter
          name="paid"
          options={[
            { value: '', label: 'Svi' },
            { value: 'no', label: 'Neplaćeni' },
            { value: 'yes', label: 'Plaćeni' },
          ]}
        />
        {filtered && (
          <Link prefetch={false} href={href({ month: null, category: null, partner: null, q: null, paid: null, source: null })} className="text-sm text-fg-3 hover:text-fg">
            Očisti filtre
          </Link>
        )}
      </FilterBar>

      <TableWrap>
        <ExpensesTable rows={data.rows} manual={data.manual} totals={t} options={options} actions={actions} paidAction={expensesPaidAction} canEdit={canEdit} attachments={attachments} count={data.rowCount} />
      </TableWrap>
      <Pagination page={pg.page} pageSize={pg.take} total={data.rowCount} params={sp} basePath="/troskovi" />
    </>
  );
}

function chip(active: boolean) {
  return cn(
    'inline-flex h-7 items-center rounded-full px-3 text-sm transition-colors',
    active ? 'bg-brand text-white' : 'bg-panel text-fg-2 shadow-[var(--shadow-panel)] hover:bg-muted',
  );
}
