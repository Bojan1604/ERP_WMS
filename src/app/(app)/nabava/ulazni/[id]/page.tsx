import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileCode2, FileText } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getCompany, getLookups } from '@/server/queries/lookups';
import { getSupplierInvoice, supplierOptions } from '@/server/queries/purchasing';
import { can } from '@/domain/permissions';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { Card, Detail, Notice, PageHeader } from '@/components/ui/misc';
import { ActionButton } from '@/components/ui/action';
import { SupplierInvoiceForm } from '@/components/purchasing/supplier-invoice-form';
import { SupplierInvoiceDecision } from '@/components/purchasing/inbound-actions';
import { SupplierInvoiceSourceBadge, SupplierInvoiceStatusBadge } from '@/components/purchasing/supplier-invoice-badges';
import { dateTime } from '@/lib/format';
import {
  acceptSupplierInvoiceAction, deleteSupplierInvoiceAction, rejectSupplierInvoiceAction, saveSupplierInvoiceAction, supplierInvoicePaidTodayAction,
} from '../actions';

export default async function SupplierInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('purchasing', 'edit');
  const { id } = await params;
  const si = await getSupplierInvoice(user.companyId, id);
  if (!si) notFound();
  const [suppliers, lookups, company] = await Promise.all([supplierOptions(user.companyId, si.supplierId), getLookups(user.companyId), getCompany(user.companyId)]);
  const categories = lookups.expenseCategories.map((c) => c.name);
  if (si.category && !categories.includes(si.category)) categories.push(si.category);

  const canEdit = can(user.perms, 'purchasing', 'edit');
  const eInvoice = si.source === 'EINVOICE';
  const rejected = si.status === 'REJECTED';
  // prihvaćen/odbijen eRačun je javljen posredniku — ne briše se
  const canDelete = canEdit && (!eInvoice || si.status === 'RECEIVED');
  const xml = si.attachments.find((a) => a.mime === 'application/xml');
  const pdfs = si.attachments.filter((a) => a.mime === 'application/pdf');
  const fileHref = (attId: string) => `/api/nabava/ulazni/${si.id}/prilog/${attId}`;

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
          canEdit && (
            <>
              <SupplierInvoiceDecision
                id={si.id}
                eInvoice={eInvoice}
                canAccept={si.status === 'RECEIVED'}
                canReject={!rejected && !si.paidDate}
                canPay={!rejected && !si.paidDate}
                accept={acceptSupplierInvoiceAction}
                reject={rejectSupplierInvoiceAction}
                paidToday={supplierInvoicePaidTodayAction}
              />
              {canDelete && (
                <ActionButton
                  action={deleteSupplierInvoiceAction}
                  input={{ id }}
                  variant="danger"
                  confirm={
                    eInvoice
                      ? `Obrisati zaprimljeni eRačun ${si.internalNo}? Posredniku se ništa ne javlja, a sljedeće preuzimanje ga ponovno upisuje.`
                      : `Obrisati ulazni račun ${si.internalNo}${si.expense ? ' i s njim knjiženi trošak' : ''}?`
                  }
                  confirmLabel="Obriši"
                >
                  Obriši
                </ActionButton>
              )}
            </>
          )
        }
      />

      {rejected && (
        <Notice tone="bad">
          <strong>Odbijen</strong>
          {si.rejectReason ? `: ${si.rejectReason}` : ''}. {eInvoice ? 'Odbijanje je javljeno dobavljaču i Poreznoj upravi.' : 'Ručni račun — odbijanje nije nikome javljeno.'} Ne
          ulazi u obveze, troškove ni izvještaje.
        </Notice>
      )}
      {si.status === 'RECEIVED' && <Notice tone="warn">Zaprimljeni eRačun čeka odluku: prihvatite ga ili odbijte s razlogom.</Notice>}

      <Card title="Status" className="mb-4">
        <dl className="grid gap-x-8 sm:grid-cols-2">
          <Detail label="Status">
            <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
              <SupplierInvoiceStatusBadge status={si.status} paid={!!si.paidDate} />
              <SupplierInvoiceSourceBadge source={si.source} />
            </span>
          </Detail>
          <Detail label="Odluka">{si.statusAt ? `${dateTime(si.statusAt)}${si.statusBy ? ` · ${si.statusBy}` : ''}` : '—'}</Detail>
          {eInvoice && (
            <>
              <Detail label="Id kod posrednika">
                <span className="break-all font-mono text-sm">{si.eInvoiceId}</span>
                {si.eInvoiceEnv && <span className="text-fg-3"> · {si.eInvoiceEnv === 'PROD' ? 'produkcija' : 'test'}</span>}
              </Detail>
              <Detail label="Status kod posrednika">{si.providerStatus || '—'}</Detail>
            </>
          )}
          {(xml || pdfs.length > 0) && (
            <Detail label="Dokumenti">
              <span className="inline-flex flex-wrap justify-end gap-x-4 gap-y-1">
                {xml && (
                  <a href={`${fileHref(xml.id)}?preuzmi`} className="link inline-flex items-center gap-1">
                    <FileCode2 className="size-4" /> eRačun XML
                  </a>
                )}
                {pdfs.map((p) => (
                  <a key={p.id} href={fileHref(p.id)} target="_blank" rel="noopener" className="link inline-flex items-center gap-1">
                    <FileText className="size-4" /> PDF
                  </a>
                ))}
              </span>
            </Detail>
          )}
        </dl>
      </Card>

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
        lockDocument={eInvoice}
        rejected={rejected}
      />
    </>
  );
}
