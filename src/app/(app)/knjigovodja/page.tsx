import Link from 'next/link';
import { Calculator, Mail } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { listAccountant } from '@/server/queries/accountant';
import { can } from '@/domain/permissions';
import { ACCOUNTANT_KIND_LABEL, ACCOUNTANT_ROW_CAP, accountantEInvoiceLabel, readAccountantFilters, type AccountantKind } from '@/domain/accountant';
import { ExportButtons } from '@/components/ui/export-buttons';
import { today } from '@/domain/dates';
import { FISCAL_STATUS_LABEL, FISCAL_STATUS_TONE } from '@/domain/fiscal';
import { Badge, Empty, Notice, PageHeader, Stat, TableWrap } from '@/components/ui/misc';
import { DateFilter, FilterBar, SearchFilter, SegmentFilter, SelectFilter } from '@/components/ui/filters';
import { SelectAll, SelectRow, SelectableTr, SelectionProvider } from '@/components/ui/selection';
import { PAY_TONE } from '@/components/sales/list-bits';
import { AccountantBar } from '@/components/accountant/accountant-bar';
import { amount, date, eur, integer } from '@/lib/format';
import { accountantKeysAction, markAccountantSentAction } from './actions';
import { Pagination, readPage } from '@/components/ui/pagination';
import { countLabel } from '@/domain/plural';

export const metadata = { title: 'Knjigovođa' };

type SP = Record<string, string | string[] | undefined>;

export default async function AccountantPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await pageAccess('reports', 'view');
  const sp = await searchParams;
  const f = readAccountantFilters(sp);
  // zadano razdoblje (ovaj mjesec) filtri datuma prikazuju kao zamjensku vrijednost — bez preusmjeravanja
  // (prije: 307 na ?od=&do= = dodatni krug do poslužitelja pri svakom otvaranju i predučitavanju)
  // popis po stranicama (100); ZIP, ispis i oznaka „poslano" za sve po filtru idu preko filtra (AccountantBar)
  const page = readPage(sp, 100);
  const [list, company] = await Promise.all([
    listAccountant(user.companyId, f, { out: can(user.perms, 'sales', 'view'), in: can(user.perms, 'purchasing', 'view') }, page),
    getCompany(user.companyId),
  ]);
  const { rows, totals, dirs } = list;
  const canMark = can(user.perms, 'reports', 'ops');
  const canSales = can(user.perms, 'sales', 'view');
  const canPurchasing = can(user.perms, 'purchasing', 'edit');
  const notSent = totals.out.notSent + totals.in.notSent;
  const subjectText = `Računi ${company.name} ${date(f.from)} – ${date(f.to)}`;
  const subject = encodeURIComponent(subjectText);
  const exportQs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v && k !== 'page') exportQs.set(k, v);
  exportQs.set('od', f.from);
  exportQs.set('do', f.to);
  const filterQs = exportQs.toString();

  return (
    <>
      <PageHeader
        title="Knjigovođa"
        subtitle={`Izlazni i ulazni računi · ${date(f.from)} – ${date(f.to)}`}
        actions={<ExportButtons href={`/api/knjigovodja/izvoz?${exportQs}`} />}
      />

      {company.accountantEmail ? (
        <Notice tone="info">
          <Mail className="mr-1.5 inline size-4 align-[-3px]" />
          Označite dokumente, preuzmite ZIP i pošaljite ga knjigovođi na{' '}
          <a href={`mailto:${company.accountantEmail}?subject=${subject}`} className="font-medium underline">
            {company.accountantEmail}
          </a>
          .
        </Notice>
      ) : (
        can(user.perms, 'settings', 'edit') && (
          <Notice tone="neutral">
            E-adresu knjigovođe možete upisati u{' '}
            <Link prefetch={false} href="/postavke" className="underline">
              Postavke → Firma
            </Link>
            .
          </Notice>
        )
      )}

      {list.capped && (
        <Notice tone="warn">
          Prikazano je najviše {integer(ACCOUNTANT_ROW_CAP)} dokumenata po smjeru — suzite razdoblje ili filtre. Zbrojevi ispod vrijede za sve filtrirane dokumente.
        </Notice>
      )}

      <FilterBar>
        <SegmentFilter
          name="smjer"
          options={[
            { value: '', label: 'Svi' },
            { value: 'izlazni', label: 'Izlazni' },
            { value: 'ulazni', label: 'Ulazni' },
          ]}
        />
        <SearchFilter placeholder="Broj, partner, OIB…" />
        <div aria-hidden className="h-0 basis-full max-sm:hidden" />
        <DateFilter name="od" label="Od" fallback={f.from} />
        <DateFilter name="do" label="Do" fallback={f.to} />
        <SelectFilter
          name="poslano"
          placeholder="Poslano i neposlano"
          options={[
            { value: 'ne', label: 'Nije poslano' },
            { value: 'da', label: 'Poslano knjigovođi' },
          ]}
        />
        <SelectFilter name="vrsta" placeholder="Sve vrste" options={(Object.keys(ACCOUNTANT_KIND_LABEL) as AccountantKind[]).map((k) => ({ value: k, label: ACCOUNTANT_KIND_LABEL[k] }))} />
      </FilterBar>

      <SelectionProvider ids={rows.map((r) => r.key)}>
        <AccountantBar
          action={markAccountantSentAction}
          keysAction={accountantKeysAction}
          filterQs={filterQs}
          total={list.listed}
          canMark={canMark}
          email={{ to: company.accountantEmail ?? null, subject: subjectText }}
        />
        <TableWrap>
          {rows.length ? (
            <table className="data-table sm:min-w-[1250px]">
              <thead>
                <tr>
                  <th className="w-8">
                    <SelectAll />
                  </th>
                  <th>Broj</th>
                  <th>Smjer</th>
                  <th>Datum</th>
                  <th>Partner</th>
                  <th>OIB</th>
                  <th>Vrsta</th>
                  <th className="num">Osnovica</th>
                  <th className="num">PDV</th>
                  <th className="num">Ukupno</th>
                  <th>Status</th>
                  <th>eRačun</th>
                  <th>Knjigovođi</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const href = r.dir === 'out' ? (canSales ? `/prodaja/racuni/${r.id}` : null) : canPurchasing ? `/nabava/ulazni/${r.id}` : null;
                  return (
                    <SelectableTr key={r.key} id={r.key}>
                      <td>
                        <SelectRow id={r.key} />
                      </td>
                      <td className="whitespace-nowrap font-medium">
                        {href ? (
                          <Link prefetch={false} href={href} className="link">
                            {r.number || '—'}
                          </Link>
                        ) : (
                          r.number || '—'
                        )}
                        {r.internalNo && <span className="block text-xs font-normal text-fg-3">{r.internalNo}</span>}
                      </td>
                      <td>{r.dir === 'out' ? <Badge tone="info">Izlazni</Badge> : <Badge tone="brand">Ulazni</Badge>}</td>
                      <td className="whitespace-nowrap">{date(r.date)}</td>
                      <td className="max-w-72 max-sm:col-span-2 max-sm:max-w-none">
                        <span className="block truncate max-sm:whitespace-normal">{r.partner}</span>
                      </td>
                      <td className="tnum text-fg-3" data-label="OIB">
                        {r.oib ?? '—'}
                      </td>
                      <td className="whitespace-nowrap">{ACCOUNTANT_KIND_LABEL[r.kind]}</td>
                      <td className="num">{amount(r.net)}</td>
                      <td className="num">{amount(r.vat)}</td>
                      <td className="num font-medium">{amount(r.total)}</td>
                      <td>
                        <span className="flex flex-wrap items-center gap-1">
                          <Badge tone={PAY_TONE[r.statusTone]}>{r.status}</Badge>
                          {r.fiscal && !r.eInvoice && (
                            <Badge tone={FISCAL_STATUS_TONE[r.fiscal]} title={`Fiskalizacija: ${FISCAL_STATUS_LABEL[r.fiscal]}`}>
                              F{r.fiscal !== 'SENT' && ` · ${FISCAL_STATUS_LABEL[r.fiscal].toLowerCase()}`}
                            </Badge>
                          )}
                          {r.attachments > 0 && (
                            <Badge tone="neutral" title="Spremljeni prilozi (idu u ZIP)">
                              priloga {r.attachments}
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td data-label="eRačun">
                        {r.eInvoice ? (
                          <Badge tone={r.eInvoice === 'INBOUND' ? 'brand' : r.fiscal ? FISCAL_STATUS_TONE[r.fiscal] : 'info'} title={r.fiscal ? `Fiskalizacija: ${FISCAL_STATUS_LABEL[r.fiscal]}` : undefined}>
                            {accountantEInvoiceLabel(r.eInvoice)}
                          </Badge>
                        ) : (
                          <span className="text-fg-4">—</span>
                        )}
                      </td>
                      <td>{r.sentAt ? <Badge tone="ok">poslano {date(today(new Date(r.sentAt)))}</Badge> : <Badge tone="warn">nije poslano</Badge>}</td>
                    </SelectableTr>
                  );
                })}
              </tbody>
              <tfoot>
                {dirs.out && (
                  <tr>
                    <td />
                    <td colSpan={6}>Izlazni: {countLabel(totals.out.count, 'dokument', 'dokumenta', 'dokumenata', integer)}</td>
                    <td className="num">{amount(totals.out.net)}</td>
                    <td className="num">{amount(totals.out.vat)}</td>
                    <td className="num">{amount(totals.out.total)}</td>
                    <td colSpan={3} />
                  </tr>
                )}
                {dirs.in && (
                  <tr>
                    <td />
                    <td colSpan={6}>Ulazni: {countLabel(totals.in.count, 'dokument', 'dokumenta', 'dokumenata', integer)}</td>
                    <td className="num">{amount(totals.in.net)}</td>
                    <td className="num">{amount(totals.in.vat)}</td>
                    <td className="num">{amount(totals.in.total)}</td>
                    <td colSpan={3} />
                  </tr>
                )}
              </tfoot>
            </table>
          ) : (
            <Empty icon={<Calculator className="size-5" />} title="Nema dokumenata u odabranom razdoblju" description="Promijenite razdoblje ili filtre." />
          )}
        </TableWrap>
      </SelectionProvider>
      <Pagination page={page.page} pageSize={page.take} total={list.listed} params={sp} basePath="/knjigovodja" />

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Dokumenata" value={integer(totals.out.count + totals.in.count)} />
        <Stat label="Izlazni (s PDV-om)" value={eur(totals.out.total)} hint={`PDV ${eur(totals.out.vat)}`} />
        <Stat label="Ulazni (s PDV-om)" value={eur(totals.in.total)} hint={`PDV ${eur(totals.in.vat)}`} />
        <Stat label="Nije poslano" value={integer(notSent)} tone={notSent ? 'warn' : 'ok'} />
      </div>
    </>
  );
}
