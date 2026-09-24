import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { num } from '@/domain/money';
import { PageHeader } from '@/components/ui/misc';
import { PartnerForm } from '@/components/partners/partner-form';
import { lookupPartnerAction, savePartnerAction } from '../actions';

export const metadata = { title: 'Novi partner' };

export default async function NewPartnerPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await pageAccess('partners', 'edit');
  const sp = await searchParams;
  const company = await getCompany(user.companyId);
  const supplier = sp.tip === 'dobavljac';
  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/partneri" className="hover:underline">
            ← Partneri
          </Link>
        }
        title="Novi partner"
      />
      <PartnerForm
        value={{
          name: sp.naziv ?? '',
          oib: null,
          vatId: null,
          address: null,
          zip: null,
          city: null,
          country: company.country || 'HR',
          email: null,
          phone: null,
          iban: null,
          contactPerson: null,
          isCustomer: !supplier,
          isSupplier: supplier,
          excluded: false,
          paymentTermDays: null,
          note: null,
        }}
        company={{ vatRegistered: company.vatRegistered, vatRate: num(company.vatRate), country: company.country, paymentTermDays: company.paymentTermDays }}
        save={savePartnerAction}
        lookup={lookupPartnerAction}
        canEdit
      />
    </>
  );
}
