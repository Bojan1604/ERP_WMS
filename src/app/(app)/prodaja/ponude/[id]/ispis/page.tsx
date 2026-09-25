import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { getQuote } from '@/server/queries/sales';
import { PageHeader } from '@/components/ui/misc';
import { PrintButton } from '@/components/ui/print-button';
import { QuoteDocument, quoteDocData } from '@/components/sales/quote-document';
import { quoteDocTitle } from '@/domain/documents';

export const metadata = { title: 'Ispis ponude' };

export default async function QuotePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('sales', 'view');
  const { id } = await params;
  const [q, company] = await Promise.all([getQuote(user.companyId, id), getCompany(user.companyId)]);
  if (!q) notFound();
  return (
    <>
      <div className="no-print">
        <PageHeader
          title={`${quoteDocTitle(q, company)} ${q.number}`}
          back={
            <Link prefetch={false} href={`/prodaja/ponude/${q.id}`} className="hover:underline">
              ← Ponuda
            </Link>
          }
          actions={<PrintButton />}
        />
      </div>
      <QuoteDocument q={quoteDocData(q)} company={company} party={q.partner} title={quoteDocTitle(q, company)} />
    </>
  );
}
