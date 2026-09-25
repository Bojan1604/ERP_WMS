import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { canSeeCost } from '@/domain/permissions';
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
  const proforma = sp.vrsta === 'predracun';
  const title = proforma ? `Novi dokument: ${lookups.company.proformaTitle || 'Predračun'}` : 'Nova ponuda';
  return (
    <>
      <PageHeader
        title={title}
        back={
          <Link prefetch={false} href="/prodaja/ponude" className="hover:underline">
            ← Ponude
          </Link>
        }
      />
      <QuoteEditor
        lookups={lookups}
        stock={{}}
        showCost={canSeeCost(user.perms)}
        canCreateService
        initial={{
          id: null,
          kind: proforma ? 'PROFORMA' : 'QUOTE',
          partnerId: partner?.id ?? null,
          date,
          validUntil: addDays(date, lookups.company.quoteValidDays),
          vatRate: customerVat(partner ?? lookups.company.country, lookups.company).rate,
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
