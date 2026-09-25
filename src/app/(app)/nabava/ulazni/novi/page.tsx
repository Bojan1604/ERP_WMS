import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getCompany, getLookups } from '@/server/queries/lookups';
import { supplierOptions } from '@/server/queries/purchasing';
import { today } from '@/domain/dates';
import { num } from '@/domain/money';
import { PageHeader } from '@/components/ui/misc';
import { SupplierInvoiceForm } from '@/components/purchasing/supplier-invoice-form';
import { saveSupplierInvoiceAction } from '../actions';

/** Novi ulazni račun; s ?narudzbenica=ID ili ?primka=ID odmah povezan s nabavom (dobavljač i iznos s dokumenta). */
export default async function NewSupplierInvoicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await pageAccess('purchasing', 'edit');
  const sp = await searchParams;
  const orderId = typeof sp.narudzbenica === 'string' ? sp.narudzbenica : null;
  const receiptId = typeof sp.primka === 'string' ? sp.primka : null;
  const [suppliers, lookups, company, order, receipt] = await Promise.all([
    supplierOptions(user.companyId),
    getLookups(user.companyId),
    getCompany(user.companyId),
    orderId ? db.purchaseOrder.findFirst({ where: { id: orderId, companyId: user.companyId }, select: { id: true, number: true, supplierId: true, total: true } }) : null,
    receiptId ? db.goodsReceipt.findFirst({ where: { id: receiptId, companyId: user.companyId }, select: { id: true, number: true, supplierId: true, total: true, orderId: true } }) : null,
  ]);
  const supplierId = receipt?.supplierId ?? order?.supplierId ?? null;
  const net = receipt ? num(receipt.total) : order ? num(order.total) : 0;
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
          supplierId,
          supplierName: null,
          supplierOib: null,
          number: '',
          issueDate: today(),
          dueDate: null,
          netAmount: net,
          vatAmount: 0,
          total: net,
          vatPct: null,
          currency: 'EUR',
          category: order || receipt ? 'Nabava robe' : null,
          note: null,
          paidDate: null,
          book: true,
          orderId: order?.id ?? receipt?.orderId ?? null,
          receiptId: receipt?.id ?? null,
        }}
        links={{
          order: order ? { value: order.id, label: order.number } : null,
          receipt: receipt ? { value: receipt.id, label: receipt.number } : null,
        }}
        suppliers={suppliers.map((s) => ({ value: s.id, label: s.name, country: s.country }))}
        categories={[...new Set([...lookups.expenseCategories.map((c) => c.name), 'Nabava robe'])]}
        company={{ vatRate: num(company.vatRate), country: company.country }}
        action={saveSupplierInvoiceAction}
      />
    </>
  );
}
