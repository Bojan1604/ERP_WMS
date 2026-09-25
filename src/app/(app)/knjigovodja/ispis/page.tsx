import Link from 'next/link';
import { can, canSeeCost } from '@/domain/permissions';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { accountantAccess, accountantKeysByFilter, accountantRowsByIds, invoicesForPrint } from '@/server/queries/accountant';
import { ACCOUNTANT_ROW_CAP, parseKeys, readAccountantFilters } from '@/domain/accountant';
import { r2 } from '@/domain/money';
import { DocTable, DocTotals, DocumentShell } from '@/components/doc/document';
import { InvoiceDocument, toDocData } from '@/components/sales/invoice-document';
import { PrintButton } from '@/components/ui/print-button';
import { Notice } from '@/components/ui/misc';
import { amount, date, integer } from '@/lib/format';

export const metadata = { title: 'Ispis za knjigovođu' };

type SP = Record<string, string | string[] | undefined>;

/**
 * Skupni ispis označenih dokumenata: svaki izlazni račun na svojoj A4 stranici
 * (jedan „Spremi kao PDF" za sve), a ulazni računi kao popis na kraju.
 */
export default async function AccountantPrintPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await pageAccess('reports', 'view');
  const sp = await searchParams;
  // `sve=1`: svi dokumenti popisa po filtrima iz URL-a (najviše ACCOUNTANT_ROW_CAP po smjeru)
  const ids =
    sp.sve === '1'
      ? parseKeys(await accountantKeysByFilter(user.companyId, readAccountantFilters(sp), accountantAccess(user.perms)))
      : parseKeys(typeof sp.ids === 'string' ? sp.ids : '');
  if (!can(user.perms, 'sales', 'view')) ids.out = [];
  const inIds = can(user.perms, 'purchasing', 'view') ? ids.in.slice(0, ACCOUNTANT_ROW_CAP) : [];
  const [company, invoices, inbound] = await Promise.all([
    getCompany(user.companyId),
    invoicesForPrint(user.companyId, ids.out),
    inIds.length ? accountantRowsByIds(user.companyId, { out: [], in: inIds }, canSeeCost(user.perms)) : Promise.resolve([]),
  ]);
  const inRows = [...inbound].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const sum = (k: 'net' | 'vat' | 'total') => r2(inRows.reduce((a, r) => a + (r[k] ?? 0), 0));
  const missing = ids.out.length + inIds.length - invoices.length - inRows.length;

  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link prefetch={false} href="/knjigovodja" className="text-sm text-fg-3 hover:text-fg">
          ← Knjigovođa
        </Link>
        <span className="text-sm text-fg-3">
          Izlaznih računa {integer(invoices.length)} · ulaznih {integer(inRows.length)}
        </span>
        <PrintButton label="Ispis / Spremi kao PDF" />
      </div>
      {missing > 0 && (
        <div className="no-print">
          <Notice tone="warn">Neki označeni dokumenti nisu pronađeni (nacrti se ne ispisuju).</Notice>
        </div>
      )}
      {invoices.length + inRows.length === 0 && (
        <div className="no-print">
          <Notice tone="neutral">Nema dokumenata za ispis — označite ih na stranici Knjigovođa.</Notice>
        </div>
      )}

      {invoices.map((inv) => (
        <div key={inv.id} className="mb-6 break-after-page print:mb-0 [&:last-child]:break-after-auto">
          <InvoiceDocument inv={toDocData(inv)} company={company} party={inv.partner} />
        </div>
      ))}

      {inRows.length > 0 && (
        <div className="break-before-page">
          <DocumentShell company={company} title="Popis ulaznih računa" meta={[['Dokumenata', integer(inRows.length)]]}>
            <DocTable
              head={['Datum', 'URA', 'Broj računa', 'Dobavljač', 'OIB', 'Osnovica', 'PDV', 'Ukupno', 'Plaćeno']}
              align={['left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'left']}
              rows={inRows.map((r) => [date(r.date), r.internalNo ?? '', r.number, r.partner, r.oib ?? '', amount(r.net), amount(r.vat), amount(r.total), r.status])}
            />
            <DocTotals
              rows={[
                ['Osnovica (EUR)', amount(sum('net'))],
                ['PDV (EUR)', amount(sum('vat'))],
                ['Ukupno (EUR)', amount(sum('total')), true],
              ]}
            />
          </DocumentShell>
        </div>
      )}
    </>
  );
}
