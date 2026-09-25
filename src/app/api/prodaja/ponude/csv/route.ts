import type { NextRequest } from 'next/server';
import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { getCompany } from '@/server/queries/lookups';
import { quoteWhere, readQuoteFilters } from '@/server/queries/sales';
import { QUOTE_STATUS_LABEL } from '@/server/services/quotes';
import { formatDate, toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { csvOrXlsx } from '@/server/xlsx';

/** Izvoz (CSV, Excel ?format=xlsx, PDF ?format=pdf) filtriranog popisa ponuda i predračuna. */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireAccess('sales', 'view');
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status });
    throw e;
  }
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const f = readQuoteFilters(sp);
  const [company, rows] = await Promise.all([
    getCompany(user.companyId),
    db.quote.findMany({
      where: quoteWhere(user.companyId, f),
      orderBy: [{ date: 'desc' }, { number: 'desc' }],
      take: 20000,
      select: {
        kind: true,
        number: true,
        date: true,
        validUntil: true,
        status: true,
        note: true,
        netTotal: true,
        grandTotal: true,
        partner: { select: { name: true, oib: true } },
        invoice: { select: { number: true } },
        contract: { select: { number: true } },
      },
    }),
  ]);
  const now = today();
  const status = (r: (typeof rows)[number]) =>
    (r.status === 'DRAFT' || r.status === 'SENT') && r.validUntil && toISO(r.validUntil) < now ? QUOTE_STATUS_LABEL.EXPIRED : QUOTE_STATUS_LABEL[r.status];
  return csvOrXlsx(
    req,
    rows,
    [
      { label: 'Broj', value: (r) => r.number },
      { label: 'Vrsta', value: (r) => (r.kind === 'PROFORMA' ? company.proformaTitle || 'Predračun' : 'Ponuda') },
      { label: 'Datum', value: (r) => formatDate(r.date) },
      { label: 'Vrijedi do', value: (r) => (r.validUntil ? formatDate(r.validUntil) : '') },
      { label: 'Kupac', value: (r) => r.partner.name },
      { label: 'OIB', value: (r) => r.partner.oib },
      { label: 'Opis', value: (r) => r.note },
      { label: 'Osnovica', value: (r) => num(r.netTotal), type: 'money' },
      { label: 'Ukupno', value: (r) => num(r.grandTotal), type: 'money' },
      { label: 'Status', value: status },
      { label: 'Račun', value: (r) => r.invoice?.number ?? '' },
      { label: 'Ugovor', value: (r) => r.contract?.number ?? '' },
    ],
    `ponude-${f.year === 'sve' ? 'sve' : f.year}-${now}`,
    'Ponude',
  );
}
