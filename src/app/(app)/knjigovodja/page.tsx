import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Calculator, Mail } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { listAccountant } from '@/server/queries/accountant';
import { can } from '@/domain/permissions';
import { ACCOUNTANT_KIND_LABEL, ACCOUNTANT_ROW_CAP, readAccountantFilters, type AccountantKind } from '@/domain/accountant';
import { today } from '@/domain/dates';
import { FISCAL_STATUS_LABEL, FISCAL_STATUS_TONE } from '@/domain/fiscal';
import { Badge, Empty, Notice, PageHeader, Stat, TableWrap } from '@/components/ui/misc';
import { DateFilter, FilterBar, SearchFilter, SegmentFilter, SelectFilter } from '@/components/ui/filters';
import { SelectAll, SelectRow, SelectableTr, SelectionProvider } from '@/components/ui/selection';
import { PAY_TONE } from '@/components/sales/list-bits';
import { AccountantBar } from '@/components/accountant/accountant-bar';
import { amount, date, eur, integer } from '@/lib/format';
import { markAccountantSentAction } from './actions';

export const metadata = { title: 'Knjigovođa' };

type SP = Record<string, string | string[] | undefined>;

export default async function AccountantPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await pageAccess('reports', 'view');
  const sp = await searchParams;
  const f = readAccountantFilters(sp);
  // zadano razdoblje upisuje se u URL da ga filtri datuma prikažu (i da je poveznica djeljiva)
  if (sp.od !== f.from || sp.do !== f.to) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v) qs.set(k, v);
    qs.set('od', f.from);
    qs.set('do', f.to);
    redirect(`/knjigovodja?${qs}`);
  }
  const [list, company] = await Promise.all([listAccountant(user.companyId, f, { out: can(user.perms, 'sales', 'view'), in: can(user.perms, 'purchasing', 'view') }), getCompany(user.companyId)]);
  const { rows, totals, dirs } = list;
  const canMark = can(user.perms, 'reports', 'ops');
  const canSales = can(user.perms, 'sales', 'view');
  const canPurchasing = can(user.perms, 'purchasing', 'edit');
  const notSent = totals.out.notSent + totals.in.notSent;
  const subject = encodeURIComponent(`Računi ${company.name} ${date(f.from)} – ${date(f.to)}`);

  return (
    <>
      <PageHeader title="Knjigovođa" subtitle={`Izlazni i ulazni računi · ${date(f.from)} – ${date(f.to)}`} />

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
        <DateFilter name="od" label="Od" />
        <DateFilter name="do" label="Do" />
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
        <AccountantBar action={markAccountantSentAction} canMark={canMark} />
        <TableWrap>
          {rows.length ? (
            <table className="data-table sm:min-w-[1100px]">
              <thead>
                <tr>
                  <th className="w-8">
                    <SelectAll />
                  </th>
                  <th>Broj</th>
                  <th>Smjer</th>
                  <th>Datum</th>
                  <th>Partner</th>
                  <th>Vrsta</th>
                  <th className="num">Osnovica</th>
                  <th className="num">PDV</th>
                  <th className="num">Ukupno</th>
                  <th>Status</th>
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
                        {r.oib && <span className="block text-xs text-fg-3 tnum">OIB {r.oib}</span>}
                      </td>
                      <td className="whitespace-nowrap">{ACCOUNTANT_KIND_LABEL[r.kind]}</td>
                      <td className="num">{amount(r.net)}</td>
                      <td className="num">{amount(r.vat)}</td>
                      <td className="num font-medium">{amount(r.total)}</td>
                      <td>
                        <span className="flex flex-wrap items-center gap-1">
                          <Badge tone={PAY_TONE[r.statusTone]}>{r.status}</Badge>
                          {r.fiscal && (
                            <Badge tone={FISCAL_STATUS_TONE[r.fiscal]} title={`${r.eInvoice ? 'eRačun' : 'Fiskalizacija'}: ${FISCAL_STATUS_LABEL[r.fiscal]}`}>
                              {r.eInvoice ? 'eRačun' : 'F'}
                              {r.fiscal !== 'SENT' && ` · ${FISCAL_STATUS_LABEL[r.fiscal].toLowerCase()}`}
                            </Badge>
                          )}
                          {r.attachments > 0 && (
                            <Badge tone="neutral" title="Spremljeni prilozi (idu u ZIP)">
                              priloga {r.attachments}
                            </Badge>
                          )}
                        </span>
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
                    <td colSpan={5}>Izlazni: {integer(totals.out.count)} dokumenata</td>
                    <td className="num">{amount(totals.out.net)}</td>
                    <td className="num">{amount(totals.out.vat)}</td>
                    <td className="num">{amount(totals.out.total)}</td>
                    <td colSpan={2} />
                  </tr>
                )}
                {dirs.in && (
                  <tr>
                    <td />
                    <td colSpan={5}>Ulazni: {integer(totals.in.count)} dokumenata</td>
                    <td className="num">{amount(totals.in.net)}</td>
                    <td className="num">{amount(totals.in.vat)}</td>
                    <td className="num">{amount(totals.in.total)}</td>
                    <td colSpan={2} />
                  </tr>
                )}
              </tfoot>
            </table>
          ) : (
            <Empty icon={<Calculator className="size-5" />} title="Nema dokumenata u odabranom razdoblju" description="Promijenite razdoblje ili filtre." />
          )}
        </TableWrap>
      </SelectionProvider>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Dokumenata" value={integer(totals.out.count + totals.in.count)} />
        <Stat label="Izlazni (s PDV-om)" value={eur(totals.out.total)} hint={`PDV ${eur(totals.out.vat)}`} />
        <Stat label="Ulazni (s PDV-om)" value={eur(totals.in.total)} hint={`PDV ${eur(totals.in.vat)}`} />
        <Stat label="Nije poslano" value={integer(notSent)} tone={notSent ? 'warn' : 'ok'} />
      </div>
    </>
  );
}
