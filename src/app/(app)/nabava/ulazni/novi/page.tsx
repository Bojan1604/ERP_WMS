import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getCompany, getLookups } from '@/server/queries/lookups';
import { partnerOptionsByIds } from '@/server/queries/partner-options';
import { goodsInvoiceContext } from '@/server/services/supplier-invoices';
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
  const [lookups, company, order, receipt] = await Promise.all([
    getLookups(user.companyId),
    getCompany(user.companyId),
    orderId ? db.purchaseOrder.findFirst({ where: { id: orderId, companyId: user.companyId }, select: { id: true, number: true, supplierId: true, total: true } }) : null,
    receiptId ? db.goodsReceipt.findFirst({ where: { id: receiptId, companyId: user.companyId }, select: { id: true, number: true, supplierId: true, total: true, orderId: true } }) : null,
  ]);
  const supplierId = receipt?.supplierId ?? order?.supplierId ?? null;
  const [supplier] = await partnerOptionsByIds(user.companyId, [supplierId]);
  const net = receipt ? num(receipt.total) : order ? num(order.total) : 0;
  const links = { orderId: order?.id ?? receipt?.orderId ?? null, receiptId: receipt?.id ?? null };
  // zadano „račun za robu s primke": obrazac ga preračunava iz UPISANE osnovice (vrijednosti robe i broj
  // računa za robu koji već postoje), a konačno odlučuje poslužitelj pri spremanju
  const ctx = links.orderId || links.receiptId ? await goodsInvoiceContext(db, user.companyId, { id: null, ...links, netAmount: net }) : null;
  const goods = ctx?.defaultGoods ?? false;
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
          goods,
          orderId: links.orderId,
          receiptId: links.receiptId,
        }}
        links={{
          order: order ? { value: order.id, label: order.number } : null,
          receipt: receipt ? { value: receipt.id, label: receipt.number } : null,
        }}
        supplier={supplier ?? null}
        categories={[...new Set([...lookups.expenseCategories.map((c) => c.name), 'Nabava robe'])]}
        company={{ vatRate: num(company.vatRate), country: company.country }}
        goodsRule={ctx ? { refs: ctx.refs, others: ctx.otherGoodsInvoices } : null}
        action={saveSupplierInvoiceAction}
      />
    </>
  );
}
