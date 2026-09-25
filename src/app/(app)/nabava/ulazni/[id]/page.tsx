import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileCode2, FileText } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getCompany, getLookups } from '@/server/queries/lookups';
import { getSupplierInvoice, recentSupplierReceipts } from '@/server/queries/purchasing';
import { partnerOptionsByIds } from '@/server/queries/partner-options';
import { can, canSeeCost } from '@/domain/permissions';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { Card, Detail, Notice, PageHeader } from '@/components/ui/misc';
import { ActionButton } from '@/components/ui/action';
import { SupplierInvoiceForm } from '@/components/purchasing/supplier-invoice-form';
import { SupplierInvoiceDecision } from '@/components/purchasing/inbound-actions';
import { SupplierInvoiceSourceBadge, SupplierInvoiceStatusBadge } from '@/components/purchasing/supplier-invoice-badges';
import { dateTime } from '@/lib/format';
import { LinkButton } from '@/components/ui/button';
import { Attachments } from '@/components/ui/attachments';
import { ProviderPdfButton } from '@/components/purchasing/provider-pdf-button';
import {
  acceptSupplierInvoiceAction, deleteSupplierInvoiceAction, providerPdfAction, rebookSupplierInvoiceAction, rejectSupplierInvoiceAction,
  saveSupplierInvoiceAction, supplierInvoicePaidTodayAction,
} from '../actions';

export default async function SupplierInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('purchasing', 'view');
  const { id } = await params;
  const si = await getSupplierInvoice(user.companyId, id);
  if (!si) notFound();
  const [[supplier], lookups, company, receipts] = await Promise.all([
    partnerOptionsByIds(user.companyId, [si.supplierId]),
    getLookups(user.companyId),
    getCompany(user.companyId),
    si.status === 'RECEIVED' ? recentSupplierReceipts(user.companyId, si.supplierId, si.issueDate) : 0,
  ]);
  const categories = lookups.expenseCategories.map((c) => c.name);
  for (const c of [si.category, 'Prijevoz']) if (c && !categories.includes(c)) categories.push(c);

  const canEdit = can(user.perms, 'purchasing', 'edit');
  const costs = canSeeCost(user.perms);
  // račun za robu otkriva nabavnu vrijednost: bez prava `costs` iznosi (i dokumenti s iznosima) se ne šalju — kao na popisu
  const hideAmounts = !costs && si.goodsInvoice === true;
  const eInvoice = si.source === 'EINVOICE';
  const rejected = si.status === 'REJECTED';
  // prihvaćen/odbijen eRačun je javljen posredniku — ne briše se
  const canDelete = canEdit && (!eInvoice || si.status === 'RECEIVED');
  // eRačun se plaća tek nakon prihvaćanja (posrednik status „plaćen" prije „prihvaćen" odbija, a plaćeni se ne može odbiti)
  const payLocked = eInvoice && si.status === 'RECEIVED';
  const xml = hideAmounts ? undefined : si.attachments.find((a) => a.mime === 'application/xml');
  const pdfs = hideAmounts ? [] : si.attachments.filter((a) => a.mime === 'application/pdf');
  const fileHref = (attId: string) => `/api/nabava/ulazni/${si.id}/prilog/${attId}`;
  // pravilo troška robe skupine: račun za robu u cijelosti pokriven primkama nema vlastitog troška
  const bookedByReceipt = si.allocation?.mode === 'receipt';
  // prihvaćen račun bez troška (spremljen bez knjiženja) — „Knjiži ponovno" (roba se nikad ne knjiži dvaput)
  const canRebook = canEdit && si.status === 'ACCEPTED' && !si.expense && !bookedByReceipt;

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
                recentReceipts={receipts}
                bookPreview={
                  si.acceptPreview
                    ? {
                        linked: si.acceptPreview.linked,
                        goods: si.acceptPreview.goods,
                        mode: si.acceptPreview.mode,
                        // iznos računa za robu je nabavna vrijednost — bez prava `costs` se ne šalje
                        ownNet: !costs && (hideAmounts || si.acceptPreview.goods) ? null : si.acceptPreview.ownNet,
                      }
                    : null
                }
                canReject={!rejected && !si.paidDate}
                canPay={!rejected && !si.paidDate && !payLocked}
                accept={acceptSupplierInvoiceAction}
                reject={rejectSupplierInvoiceAction}
                paidToday={supplierInvoicePaidTodayAction}
              />
              {si.order && (
                <LinkButton href={`/nabava/narudzbenice/${si.order.id}`}>Narudžbenica {si.order.number}</LinkButton>
              )}
              {si.receipt && <LinkButton href={`/nabava/primke/${si.receipt.id}`}>Primka {si.receipt.number}</LinkButton>}
              {eInvoice && !hideAmounts && <ProviderPdfButton id={si.id} action={providerPdfAction} />}
              {canRebook && (
                <ActionButton
                  action={rebookSupplierInvoiceAction}
                  input={{ id }}
                  variant="primary"
                  title="Trošak je obrisan ili nikad nije knjižen — knjiži ga ponovno (nikad dvaput)"
                  confirm={`Knjižiti ulazni račun ${si.internalNo} kao trošak?`}
                  confirmLabel="Knjiži ponovno"
                >
                  Knjiži ponovno
                </ActionButton>
              )}
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
      {canRebook && (
        <Notice tone="warn">Račun je prihvaćen, ali nije knjižen kao trošak (trošak je obrisan ili nije knjižen). „Knjiži ponovno" ga knjiži.</Notice>
      )}
      {si.status === 'RECEIVED' && <Notice tone="warn">Zaprimljeni eRačun čeka odluku: prihvatite ga ili odbijte s razlogom. Plaćanje se označava nakon prihvaćanja.</Notice>}

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
          supplierName: si.supplierName,
          supplierOib: si.supplierOib,
          number: si.number,
          issueDate: toISO(si.issueDate),
          dueDate: si.dueDate ? toISO(si.dueDate) : null,
          netAmount: hideAmounts ? 0 : num(si.netAmount),
          vatAmount: hideAmounts ? 0 : num(si.vatAmount),
          total: hideAmounts ? 0 : num(si.total),
          category: si.category,
          note: si.note,
          paidDate: si.paidDate ? toISO(si.paidDate) : null,
          book: si.bookExpense,
          // spremljena odluka; stariji račun bez nje — bez vlastitog troška uz knjiženu primku = račun za robu, inače pravilo iznosa
          goods: si.goodsInvoice ?? (!si.expense && (bookedByReceipt || si.defaultGoods)),
          vatPct: si.vatPct === null || hideAmounts ? null : num(si.vatPct),
          currency: si.currency,
          orderId: si.orderId,
          receiptId: si.receiptId,
        }}
        links={{
          order: si.order ? { value: si.order.id, label: si.order.number } : null,
          receipt: si.receipt ? { value: si.receipt.id, label: si.receipt.number } : null,
        }}
        expense={
          si.allocation && {
            mode: si.allocation.mode,
            // iznosi pokrića primkama otkrivaju nabavnu vrijednost — samo uz pravo `costs`
            covered: costs ? si.allocation.covered : null,
            ownNet: costs ? si.allocation.ownNet : null,
          }
        }
        goodsRule={si.goodsInvoice === null && costs ? si.goodsRule : null}
        supplier={supplier ?? null}
        categories={categories}
        company={{ vatRate: num(company.vatRate), country: company.country }}
        action={saveSupplierInvoiceAction}
        lockDocument={eInvoice}
        rejected={rejected}
        payLocked={payLocked}
        readOnly={!canEdit || hideAmounts}
        hideAmounts={hideAmounts}
      />

      {!hideAmounts && (
        <Card title="Prilozi (sken, PDF računa)" className="mt-4">
          <Attachments entity="supplierInvoice" id={si.id} canEdit={canEdit} initial={si.attachments} />
        </Card>
      )}
    </>
  );
}
