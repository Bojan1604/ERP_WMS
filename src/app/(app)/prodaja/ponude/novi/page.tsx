import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { getSalesLookups } from '@/server/queries/sales';
import { customerVat } from '@/domain/tax';
import { addDays, today } from '@/domain/dates';
import { PageHeader } from '@/components/ui/misc';
import { QuoteEditor } from '@/components/sales/quote-editor';

export const metadata = { title: 'Nova ponuda' };

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await pageAccess('sales', 'edit');
  const sp = await searchParams;
  const lookups = await getSalesLookups(user.companyId);
  const partner = lookups.partners.find((p) => p.id === sp.partner) ?? null;
  const date = today();
  return (
    <>
      <PageHeader
        title="Nova ponuda"
        back={
          <Link prefetch={false} href="/prodaja/ponude" className="hover:underline">
            ← Ponude
          </Link>
        }
      />
      <QuoteEditor
        lookups={lookups}
        stock={{}}
        initial={{
          id: null,
          partnerId: partner?.id ?? null,
          date,
          validUntil: addDays(date, lookups.company.quoteValidDays),
          vatRate: customerVat(partner?.country ?? lookups.company.country, lookups.company).rate,
          discountPct: 0,
          discountAmount: 0,
          hideSerials: false,
          note: '',
          lines: [],
        }}
      />
    </>
  );
}
