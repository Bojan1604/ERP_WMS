import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany, getLookups } from '@/server/queries/lookups';
import { getSupplierInvoice, supplierOptions } from '@/server/queries/purchasing';
import { can } from '@/domain/permissions';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { PageHeader } from '@/components/ui/misc';
import { ActionButton } from '@/components/ui/action';
import { SupplierInvoiceForm } from '@/components/purchasing/supplier-invoice-form';
import { deleteSupplierInvoiceAction, saveSupplierInvoiceAction } from '../actions';

export default async function SupplierInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('purchasing', 'edit');
  const { id } = await params;
  const si = await getSupplierInvoice(user.companyId, id);
  if (!si) notFound();
  const [suppliers, lookups, company] = await Promise.all([supplierOptions(user.companyId, si.supplierId), getLookups(user.companyId), getCompany(user.companyId)]);
  const categories = lookups.expenseCategories.map((c) => c.name);
  if (si.category && !categories.includes(si.category)) categories.push(si.category);

  return (
    <>
      <PageHeader
        title={`Ulazni račun ${si.internalNo}`}
        subtitle={`${si.supplier.name} · račun ${si.number}`}
        back={
          <Link prefetch={false} href="/nabava/ulazni" className="hover:text-fg">
            ← Ulazni računi
          </Link>
        }
        actions={
          can(user.perms, 'purchasing', 'edit') && (
            <ActionButton
              action={deleteSupplierInvoiceAction}
              input={{ id }}
              variant="danger"
              confirm={`Obrisati ulazni račun ${si.internalNo}${si.expense ? ' i s njim knjiženi trošak' : ''}?`}
              confirmLabel="Obriši"
            >
              Obriši
            </ActionButton>
          )
        }
      />
      <SupplierInvoiceForm
        initial={{
          id: si.id,
          internalNo: si.internalNo,
          supplierId: si.supplierId,
          number: si.number,
          issueDate: toISO(si.issueDate),
          dueDate: si.dueDate ? toISO(si.dueDate) : null,
          netAmount: num(si.netAmount),
          vatAmount: num(si.vatAmount),
          total: num(si.total),
          category: si.category,
          note: si.note,
          paidDate: si.paidDate ? toISO(si.paidDate) : null,
          book: !!si.expense,
        }}
        suppliers={suppliers.map((s) => ({ value: s.id, label: s.name, country: s.country }))}
        categories={categories}
        company={{ vatRate: num(company.vatRate), country: company.country }}
        action={saveSupplierInvoiceAction}
      />
    </>
  );
}
