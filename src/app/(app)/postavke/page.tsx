import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { can } from '@/domain/permissions';
import { num } from '@/domain/money';
import { PageHeader } from '@/components/ui/misc';
import { CompanyForm } from '@/components/settings/company-form';
import { saveCompanyAction } from './actions';

export const metadata = { title: 'Postavke firme' };

export default async function CompanySettingsPage() {
  const user = await pageAccess('settings');
  const c = await getCompany(user.companyId);
  return (
    <>
      <PageHeader title="Firma i postavke" subtitle="Podaci za dokumente, porez, rokovi, cijene i numeracija računa" />
      <CompanyForm
        canEdit={can(user.perms, 'settings', 'edit')}
        save={saveCompanyAction}
        value={{
          name: c.name,
          oib: c.oib,
          vatId: c.vatId,
          address: c.address,
          zip: c.zip,
          city: c.city,
          country: c.country,
          iban: c.iban,
          bank: c.bank,
          email: c.email,
          accountantEmail: c.accountantEmail,
          phone: c.phone,
          web: c.web,
          logo: c.logo,
          currency: c.currency,
          vatRegistered: c.vatRegistered,
          vatRate: num(c.vatRate),
          overdueDays: c.overdueDays,
          paymentTermDays: c.paymentTermDays,
          quoteValidDays: c.quoteValidDays,
          defaultMarginPct: num(c.defaultMarginPct),
          defaultWarrantyMonths: c.defaultWarrantyMonths,
          rentFallbackPct: num(c.rentFallbackPct),
          invoicePremises: c.invoicePremises,
          invoiceDevice: c.invoiceDevice,
          invoiceSeparator: c.invoiceSeparator,
          invoiceFooter: c.invoiceFooter,
          statusChangeNeedsApproval: c.statusChangeNeedsApproval,
        }}
      />
    </>
  );
}
