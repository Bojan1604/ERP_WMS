import Link from 'next/link';
import { Printer } from 'lucide-react';
import { partnerContracts, partnerDevices, partnerInvoices, partnerLedger } from '@/server/queries/partners';
import { Badge, COLOR_TONE, Empty, TableWrap, type Tone } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { Pagination, readPage } from '@/components/ui/pagination';
import { amount, date, eur, integer } from '@/lib/format';
import { paymentState, INVOICE_KIND_LABEL } from '@/domain/invoice';
import { CONTRACT_STATUS_LABEL, BILLING_LABEL } from '@/domain/billing';
import { toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { cn } from '@/lib/cn';
import { ExportButtons } from '@/components/ui/export-buttons';

type Params = Record<string, string | string[] | undefined>;

const STATE_TONE: Record<string, Tone> = { neutral: 'neutral', positive: 'ok', warning: 'warn', negative: 'bad', info: 'info', accent: 'brand' };
const TYPE_LABEL = { SALE: 'Prodaja', RENT: 'Najam', SERVICE: 'Usluge' } as const;

export async function InvoicesTab({ companyId, partnerId, params, overdueDays }: { companyId: string; partnerId: string; params: Params; overdueDays: number }) {
  const page = readPage(params, 50);
  const { rows, total, sums } = await partnerInvoices(companyId, partnerId, page);
  if (!total) return <TableWrap><Empty title="Partner nema računa" /></TableWrap>;
  const now = today();
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-fg-3">
        <span>Promet (neto): <b className="text-fg tnum">{eur(sums.net)}</b></span>
        <span>S PDV-om: <b className="text-fg tnum">{eur(sums.gross)}</b></span>
        <span>Otvoreno: <b className={cn('tnum', sums.open > 0 ? 'text-bad-strong' : 'text-fg')}>{eur(sums.open)}</b></span>
        {sums.overpaid > 0 && <span title="Preplata — kupac je platio više od iznosa računa">Za povrat kupcu: <b className="tnum text-warn">{eur(sums.overpaid)}</b></span>}
      </div>
      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th>Broj</th>
              <th>Datum</th>
              <th>Dospijeće</th>
              <th>Vrsta</th>
              <th className="num">Neto</th>
              <th className="num">Ukupno</th>
              <th className="num">Otvoreno</th>
              <th>Stanje</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => {
              const st = paymentState(
                {
                  status: i.status,
                  kind: i.kind,
                  stornoed: i.stornoed,
                  date: toISO(i.date),
                  dueDate: i.dueDate ? toISO(i.dueDate) : null,
                  total: num(i.grandTotal),
                  paid: num(i.paidTotal),
                  open: num(i.openAmount),
                  lastPaymentDate: i.paidDate ? toISO(i.paidDate) : null,
                },
                overdueDays,
                now,
              );
              return (
                <tr key={i.id}>
                  <td>
                    <Link prefetch={false} href={`/prodaja/racuni/${i.id}`} className="link font-medium">
                      {i.number ?? 'Nacrt'}
                    </Link>
                  </td>
                  <td>{date(i.date)}</td>
                  <td>{date(i.dueDate)}</td>
                  <td className="text-fg-2">
                    {i.kind === 'INVOICE' ? TYPE_LABEL[i.type] : INVOICE_KIND_LABEL[i.kind]}
                  </td>
                  <td className="num">{amount(num(i.netTotal))}</td>
                  <td className="num">{amount(num(i.grandTotal))}</td>
                  <td className="num">{num(i.openAmount) ? <b>{amount(num(i.openAmount))}</b> : <span className="text-fg-4">—</span>}</td>
                  <td>
                    <Badge tone={STATE_TONE[st.tone]}>{st.label}</Badge>
                    {st.key === 'overdue' && <span className="ml-1.5 text-xs text-fg-3">{st.days} d</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath={`/partneri/${partnerId}`} />
    </>
  );
}

export async function DevicesTab({ companyId, partnerId, params }: { companyId: string; partnerId: string; params: Params }) {
  const page = readPage(params, 100);
  const { rows, total } = await partnerDevices(companyId, partnerId, page);
  const now = today();
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-3">Uređaji koji su trenutno kod partnera (kupljeni, u najmu, izašli sa skladišta…).</p>
        {total > 0 && (
          <div className="flex gap-2">
            <LinkButton href={`/partneri/${partnerId}/uredaji`} icon={<Printer className="size-4" />}>
              Popis uređaja za klijenta
            </LinkButton>
            <ExportButtons href={`/api/partneri/${partnerId}/uredaji?pogled=sve`} />
          </div>
        )}
      </div>
      <TableWrap>
        {rows.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Serijski broj</th>
                <th>Model</th>
                <th>Status</th>
                <th>Od</th>
                <th>Jamstvo do</th>
                <th>Ugovor</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const wEnd = i.warrantyEnd;
                return (
                  <tr key={i.id}>
                    <td>
                      <Link prefetch={false} href={`/skladiste/${i.id}`} className="link font-mono">
                        {i.serial}
                      </Link>
                    </td>
                    <td>{[i.model.brand, i.model.name].filter(Boolean).join(' ')}</td>
                    <td>
                      <Badge tone={COLOR_TONE[i.status.color] ?? 'neutral'}>{i.status.name}</Badge>
                    </td>
                    <td>{date(i.issueDate)}</td>
                    <td className={cn(wEnd && wEnd < now && 'text-fg-3')}>{wEnd ? date(wEnd) : '—'}</td>
                    <td>
                      {i.contractItem ? (
                        <Link prefetch={false} href={`/najam/ugovori/${i.contractItem.contract.id}`} className="link">
                          {i.contractItem.contract.number}
                        </Link>
                      ) : (
                        <span className="text-fg-4">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty title="Kod partnera nema uređaja" />
        )}
      </TableWrap>
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath={`/partneri/${partnerId}`} />
    </>
  );
}

const CONTRACT_TONE: Record<string, Tone> = { ACTIVE: 'ok', PAUSED: 'warn', EXPIRED: 'neutral', TERMINATED: 'bad' };

export async function ContractsTab({ companyId, partnerId }: { companyId: string; partnerId: string }) {
  const rows = await partnerContracts(companyId, partnerId);
  if (!rows.length) return <TableWrap><Empty title="Partner nema ugovora o najmu" /></TableWrap>;
  return (
    <TableWrap>
      <table className="data-table">
        <thead>
          <tr>
            <th>Broj</th>
            <th>Status</th>
            <th>Početak</th>
            <th>Kraj</th>
            <th>Naplata</th>
            <th className="num">Uređaja</th>
            <th className="num">Mjesečno</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                <Link prefetch={false} href={`/najam/ugovori/${c.id}`} className="link font-medium">
                  {c.number}
                </Link>
              </td>
              <td>
                <Badge tone={CONTRACT_TONE[c.status]}>{CONTRACT_STATUS_LABEL[c.status]}</Badge>
              </td>
              <td>{date(c.startDate)}</td>
              <td>{c.endDate ? date(c.endDate) : <span className="text-fg-3">neodređeno</span>}</td>
              <td>{BILLING_LABEL[c.billing]}</td>
              <td className="num">{integer(c.devices)}</td>
              <td className="num">{eur(c.monthly)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export async function LedgerTab({ companyId, partnerId, params }: { companyId: string; partnerId: string; params: Record<string, string | string[] | undefined> }) {
  // stranica 1 = najnovijih 100 stavki; zbrojevi i saldo preko cijele kartice
  const pg = readPage(params, 100);
  const { rows, total, debit, credit, balance } = await partnerLedger(companyId, partnerId, pg);
  if (!total) return <TableWrap><Empty title="Kartica je prazna" description="Partner nema izdanih računa ni uplata." /></TableWrap>;
  return (
    <>
      <p className="mb-3 text-sm text-fg-3">Izdani računi (duguje) i uplate (potražuje) kronološki; storna i odobrenja umanjuju dug.{total > pg.take && ' Prva stranica prikazuje najnovije stavke.'}</p>
      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th>Datum</th>
              <th>Dokument</th>
              <th>Opis</th>
              <th className="num">Duguje</th>
              <th className="num">Potražuje</th>
              <th className="num">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{date(r.date)}</td>
                <td>
                  <Link prefetch={false} href={`/prodaja/racuni/${r.invoiceId}`} className="link">
                    {r.kind === 'payment' ? `Uplata · ${r.number ?? ''}` : r.number}
                  </Link>
                </td>
                <td className="max-w-md truncate text-fg-2">
                  {r.kind === 'invoice' ? (r.invKind && r.invKind !== 'INVOICE' ? INVOICE_KIND_LABEL[r.invKind as keyof typeof INVOICE_KIND_LABEL] : r.description ?? 'Račun') : (r.description ?? 'Uplata')}
                </td>
                <td className="num">{r.debit ? amount(r.debit) : ''}</td>
                <td className="num">{r.credit ? amount(r.credit) : ''}</td>
                <td className={cn('num font-medium', r.balance > 0.005 && 'text-fg', r.balance < -0.005 && 'text-ok')}>{amount(r.balance)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Ukupno ({integer(total)} stavki)</td>
              <td className="num">{amount(debit)}</td>
              <td className="num">{amount(credit)}</td>
              <td className="num">{amount(balance)}</td>
            </tr>
          </tfoot>
        </table>
      </TableWrap>
      <Pagination page={pg.page} pageSize={pg.take} total={total} params={params} basePath={`/partneri/${partnerId}`} />
    </>
  );
}
