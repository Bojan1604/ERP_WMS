import type { NextRequest } from 'next/server';
import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { getCompany } from '@/server/queries/lookups';
import { invoiceOrder, invoiceWhere, readInvoiceFilters } from '@/server/queries/sales';
import { paymentState, INVOICE_KIND_LABEL } from '@/domain/invoice';
import { formatDate, toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { csvResponse, toCsv } from '@/lib/csv';

const TYPE: Record<string, string> = { SALE: 'Prodaja', RENT: 'Najam', SERVICE: 'Usluga' };

/** Izvoz filtriranog popisa računa (isti filtri kao na ekranu). */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireAccess('sales', 'view');
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status });
    throw e;
  }
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const f = readInvoiceFilters(sp);
  const company = await getCompany(user.companyId);
  const rows = await db.invoice.findMany({
    where: invoiceWhere(user.companyId, f, company.overdueDays),
    orderBy: invoiceOrder(f.sort) ?? [{ date: 'desc' }, { seq: 'desc' }],
    take: 20000,
    select: {
      number: true,
      status: true,
      kind: true,
      type: true,
      date: true,
      dueDate: true,
      stornoed: true,
      netTotal: true,
      vatTotal: true,
      chargesTotal: true,
      grandTotal: true,
      paidTotal: true,
      openAmount: true,
      paidDate: true,
      description: true,
      partner: { select: { name: true, oib: true } },
    },
  });
  const csv = toCsv(rows, [
    { label: 'Broj', value: (r) => r.number ?? 'Nacrt' },
    { label: 'Dokument', value: (r) => INVOICE_KIND_LABEL[r.kind] },
    { label: 'Vrsta', value: (r) => TYPE[r.type] },
    { label: 'Datum', value: (r) => formatDate(r.date) },
    { label: 'Dospijeće', value: (r) => (r.dueDate ? formatDate(r.dueDate) : '') },
    { label: 'Partner', value: (r) => r.partner.name },
    { label: 'OIB', value: (r) => r.partner.oib },
    { label: 'Opis', value: (r) => r.description },
    { label: 'Osnovica', value: (r) => num(r.netTotal) },
    { label: 'PDV', value: (r) => num(r.vatTotal) },
    { label: 'Naknade', value: (r) => num(r.chargesTotal) },
    { label: 'Ukupno', value: (r) => num(r.grandTotal) },
    { label: 'Plaćeno', value: (r) => num(r.paidTotal) },
    { label: 'Otvoreno', value: (r) => num(r.openAmount) },
    { label: 'Datum plaćanja', value: (r) => (r.paidDate ? formatDate(r.paidDate) : '') },
    {
      label: 'Stanje',
      value: (r) =>
        paymentState(
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
          company.overdueDays,
        ).label,
    },
  ]);
  return csvResponse(csv, `racuni-${f.year === 'sve' ? 'sve' : f.year}-${today()}.csv`);
}
