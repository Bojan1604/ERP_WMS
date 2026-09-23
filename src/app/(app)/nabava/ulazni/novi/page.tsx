import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { getCompany, getLookups } from '@/server/queries/lookups';
import { supplierOptions } from '@/server/queries/purchasing';
import { today } from '@/domain/dates';
import { num } from '@/domain/money';
import { PageHeader } from '@/components/ui/misc';
import { SupplierInvoiceForm } from '@/components/purchasing/supplier-invoice-form';
import { saveSupplierInvoiceAction } from '../actions';

export default async function NewSupplierInvoicePage() {
  const user = await pageAccess('purchasing', 'edit');
  const [suppliers, lookups, company] = await Promise.all([supplierOptions(user.companyId), getLookups(user.companyId), getCompany(user.companyId)]);
  return (
    <>
      <PageHeader
        title="Novi ulazni račun"
        back={
          <Link prefetch={false} href="/nabava/ulazni" className="hover:text-fg">
            ← Ulazni računi
          </Link>
        }
      />
      <SupplierInvoiceForm
        initial={{
          id: null,
          internalNo: null,
          supplierId: null,
          number: '',
          issueDate: today(),
          dueDate: null,
          netAmount: 0,
          vatAmount: 0,
          total: 0,
          category: null,
          note: null,
          paidDate: null,
          book: true,
        }}
        suppliers={suppliers.map((s) => ({ value: s.id, label: s.name, country: s.country }))}
        categories={lookups.expenseCategories.map((c) => c.name)}
        company={{ vatRate: num(company.vatRate), country: company.country }}
        action={saveSupplierInvoiceAction}
      />
    </>
  );
}
