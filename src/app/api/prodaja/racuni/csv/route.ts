import type { NextRequest } from 'next/server';
import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { getCompany } from '@/server/queries/lookups';
import { invoiceOrder, invoiceWhere, readInvoiceFilters, resolveInvoiceSearch } from '@/server/queries/sales';
import { attachmentCounts } from '@/server/services/attachments';
import { EINVOICE_STATUS_LABEL, type EInvoiceStatusCode } from '@/domain/sales-lines';
import { amount } from '@/lib/format';
import { paymentState, INVOICE_KIND_LABEL } from '@/domain/invoice';
import { formatDate, toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { csvOrXlsx } from '@/server/xlsx';

const TYPE: Record<string, string> = { SALE: 'Prodaja', RENT: 'Najam', SERVICE: 'Usluga' };

/** Izvoz (CSV ili Excel s ?format=xlsx) filtriranog popisa računa (isti filtri kao na ekranu). */
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
  const [company, serialIds] = await Promise.all([getCompany(user.companyId), f.q ? resolveInvoiceSearch(user.companyId, f.q) : Promise.resolve([])]);
  const rows = await db.invoice.findMany({
    where: invoiceWhere(user.companyId, f, company.overdueDays, serialIds),
    orderBy: invoiceOrder(f.sort) ?? [{ date: 'desc' }, { seq: 'desc' }],
    take: 20000,
    select: {
      id: true,
      period: true,
      eInvoiceStatus: true,
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
  const files = await attachmentCounts(db, user.companyId, 'invoice', rows.map((r) => r.id));
  return csvOrXlsx(
    req,
    rows,
    [
    { label: 'Broj', value: (r) => r.number ?? 'Nacrt' },
    { label: 'Dokument', value: (r) => INVOICE_KIND_LABEL[r.kind] },
    { label: 'Vrsta', value: (r) => TYPE[r.type] },
    { label: 'Datum', value: (r) => formatDate(r.date) },
    { label: 'Dospijeće', value: (r) => (r.dueDate ? formatDate(r.dueDate) : '') },
    { label: 'Partner', value: (r) => r.partner.name },
    { label: 'OIB', value: (r) => r.partner.oib },
    { label: 'Opis', value: (r) => r.description },
    { label: 'Razdoblje najma', value: (r) => r.period ?? '' },
    { label: 'Osnovica', value: (r) => num(r.netTotal), type: 'money' },
    { label: 'PDV', value: (r) => num(r.vatTotal), type: 'money' },
    { label: 'Naknade', value: (r) => num(r.chargesTotal), type: 'money' },
    { label: 'Ukupno', value: (r) => num(r.grandTotal), type: 'money' },
    { label: 'Uplaćeno', value: (r) => num(r.paidTotal), type: 'money' },
    { label: 'Otvoreno', value: (r) => num(r.openAmount), type: 'money' },
    {
      label: 'Plaćeno',
      // datum plaćanja, a kod djelomične uplate „uplaćeno / ukupno"
      value: (r) => (r.paidDate ? formatDate(r.paidDate) : num(r.paidTotal) > 0 ? `${amount(num(r.paidTotal))} / ${amount(num(r.grandTotal))}` : ''),
    },
    { label: 'eRačun', value: (r) => (r.eInvoiceStatus ? (EINVOICE_STATUS_LABEL[r.eInvoiceStatus as EInvoiceStatusCode] ?? r.eInvoiceStatus) : '') },
    { label: 'Privitaka', value: (r) => files.get(r.id) ?? 0, type: 'int' },
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
  ],
    `racuni-${f.year === 'sve' ? 'sve' : f.year}-${today()}`,
    'Računi',
  );
}
