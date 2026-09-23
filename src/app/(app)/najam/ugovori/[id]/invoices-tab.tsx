import Link from 'next/link';
import type { Contract } from '@prisma/client';
import { Receipt } from 'lucide-react';
import { Badge, Empty, TableWrap, type Tone } from '@/components/ui/misc';
import { Pagination, readPage } from '@/components/ui/pagination';
import { paymentState, type PaymentState } from '@/domain/invoice';
import { periodLabel, toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { contractInvoices } from '@/server/queries/rentals';
import { getCompany } from '@/server/queries/lookups';
import { date, eur } from '@/lib/format';

const TONE: Record<PaymentState['tone'], Tone> = { neutral: 'neutral', positive: 'ok', warning: 'warn', negative: 'bad', info: 'info', accent: 'brand' };

export async function InvoicesTab({ contract: c, companyId, params }: { contract: Contract; companyId: string; params: Record<string, string | string[] | undefined> }) {
  const page = readPage(params, 50);
  const [{ total, rows }, company] = await Promise.all([contractInvoices(companyId, c.id, page), getCompany(companyId)]);
  if (!rows.length) {
    return (
      <TableWrap>
        <Empty icon={<Receipt className="size-5" />} title="Nema računa" description="Računi za rate izdani s popisa „Rate za izdati“ pojavljuju se ovdje." />
      </TableWrap>
    );
  }
  return (
    <>
      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th>Broj</th>
              <th>Datum</th>
              <th>Razdoblje</th>
              <th className="num">Iznos</th>
              <th className="num">Otvoreno</th>
              <th>Naplata</th>
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
                company.overdueDays,
              );
              return (
                <tr key={i.id}>
                  <td>
                    <Link prefetch={false} href={`/prodaja/racuni/${i.id}`} className="link font-medium">
                      {i.number ?? 'Nacrt'}
                    </Link>
                  </td>
                  <td>{date(i.date)}</td>
                  <td className="capitalize">{i.period ? periodLabel(i.period) : '—'}</td>
                  <td className="num">{eur(num(i.grandTotal))}</td>
                  <td className="num">{num(i.openAmount) ? eur(num(i.openAmount)) : '—'}</td>
                  <td>
                    <Badge tone={TONE[st.tone]}>{st.label}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath={`/najam/ugovori/${c.id}`} />
    </>
  );
}
