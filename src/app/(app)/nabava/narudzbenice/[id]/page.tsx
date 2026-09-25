import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil, Printer, Send } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getLookups, modelLabel } from '@/server/queries/lookups';
import { getOrder } from '@/server/queries/purchasing';
import { can, canSeeCost } from '@/domain/permissions';
import { num, r2 } from '@/domain/money';
import { toISO, today } from '@/domain/dates';
import { db } from '@/server/db';
import { listAttachments } from '@/server/services/attachments';
import { goodsExpensePlan } from '@/server/services/goods-expense';
import { Attachments } from '@/components/ui/attachments';
import { OrderInvoiceForm } from '@/components/purchasing/order-invoice-form';
import { SupplierInvoiceStatusBadge } from '@/components/purchasing/supplier-invoice-badges';
import { Badge, Card, Detail, PageHeader, TableWrap } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { MoreMenu } from '@/components/ui/more-menu';
import { ActionButton } from '@/components/ui/action';
import { ReceiveDialog } from '@/components/purchasing/receive-dialog';
import { ORDER_STATUS, RECEIPT_STATUS } from '@/components/purchasing/labels';
import { date, dateTime, eur, integer } from '@/lib/format';
import { deleteOrderAction, orderStatusAction, receiveLineAction } from '../actions';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('purchasing', 'view');
  const { id } = await params;
  const [order, lookups, files] = await Promise.all([getOrder(user.companyId, id), getLookups(user.companyId), listAttachments(db, user.companyId, 'purchaseOrder', [id])]);
  if (!order) notFound();
  const canEdit = can(user.perms, 'purchasing', 'edit');
  const costs = canSeeCost(user.perms);
  // stanje troška robe (pravilo max(primke, računi za robu)) za dijalog zaprimanja — samo uz pravo `costs`
  const plan = costs ? await goodsExpensePlan(db, user.companyId, { orderId: id }) : null;
  const goodsPlan = plan ? { receiptsBooked: plan.receiptsBooked, invoices: plan.rows } : null;
  const st = ORDER_STATUS[order.status];
  const receivable = order.status === 'ORDERED' || order.status === 'PARTIAL';
  const editable = order.status !== 'RECEIVED' && order.status !== 'CANCELLED';
  const postedReceipts = order.receipts.filter((r) => r.status === 'POSTED').length;
  const qty = order.lines.reduce((a, l) => a + l.qty, 0);
  const received = order.lines.reduce((a, l) => a + l.received, 0);
  const warehouses = lookups.warehouses.map((w) => ({ value: w.id, label: w.name }));

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Narudžbenica {order.number} <Badge tone={st.tone}>{st.label}</Badge>
          </span>
        }
        subtitle={`${order.supplier.name} · ${date(order.date)}`}
        back={
          <Link prefetch={false} href="/nabava/narudzbenice" className="hover:text-fg">
            ← Narudžbenice
          </Link>
        }
        actions={
          <>
            <LinkButton href={`/nabava/narudzbenice/${id}/ispis`} icon={<Printer className="size-4" />}>
              Ispis
            </LinkButton>
            {canEdit && costs && editable && (
              <LinkButton href={`/nabava/narudzbenice/${id}/uredi`} icon={<Pencil className="size-4" />}>
                Uredi
              </LinkButton>
            )}
            {canEdit && order.status === 'DRAFT' && (
              <ActionButton action={orderStatusAction} input={{ id, to: 'ORDERED' as const }} variant="primary" icon={<Send className="size-4" />}>
                Pošalji dobavljaču
              </ActionButton>
            )}
            {/* na mobitelu sporedne radnje su iza gumba „Više" */}
            {canEdit && (((order.status === 'ORDERED' || order.status === 'CANCELLED') && received === 0) || editable || postedReceipts === 0) && (
              <MoreMenu>
                {canEdit && (order.status === 'ORDERED' || order.status === 'CANCELLED') && received === 0 && (
                  <ActionButton action={orderStatusAction} input={{ id, to: 'DRAFT' as const }} variant="ghost">
                    Vrati u nacrt
                  </ActionButton>
                )}
                {canEdit && editable && (
                  <ActionButton
                    action={orderStatusAction}
                    input={{ id, to: 'CANCELLED' as const }}
                    variant="ghost"
                    confirm={received ? 'Dio robe je već zaprimljen. Otkazivanjem se ostatak više ne očekuje. Nastaviti?' : 'Otkazati narudžbenicu?'}
                    confirmLabel="Otkaži narudžbenicu"
                  >
                    Otkaži
                  </ActionButton>
                )}
                {canEdit && postedReceipts === 0 && (
                  <ActionButton
                    action={deleteOrderAction}
                    input={{ id }}
                    variant="danger"
                    confirm={`Trajno obrisati narudžbenicu ${order.number}?`}
                    confirmLabel="Obriši"
                  >
                    Obriši
                  </ActionButton>
                )}
              </MoreMenu>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Naručeno</th>
                  <th className="num">Zaprimljeno</th>
                  <th className="num">Preostalo</th>
                  {costs && <th className="num">Nabavna</th>}
                  {costs && <th className="num">Iznos</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {order.lines.map((l) => {
                  const left = Math.max(0, l.qty - l.received);
                  return (
                    <tr key={l.id}>
                      <td>
                        {modelLabel(l.model)}
                        {l.model.code && <span className="ml-1.5 text-xs text-fg-3">{l.model.code}</span>}
                      </td>
                      <td className="num">{integer(l.qty)}</td>
                      <td className="num">{l.received >= l.qty ? <span className="text-ok">{integer(l.received)}</span> : integer(l.received)}</td>
                      <td className="num">{left ? <b>{integer(left)}</b> : '—'}</td>
                      {costs && <td className="num">{eur(num(l.unitCost))}</td>}
                      {costs && <td className="num">{eur(r2(l.qty * num(l.unitCost)))}</td>}
                      <td className="num">
                        {canEdit && receivable && left > 0 && (
                          <ReceiveDialog
                            orderId={id}
                            line={{ id: l.id, model: modelLabel(l.model), remaining: left, unitCost: costs ? num(l.unitCost) : 0 }}
                            warehouses={warehouses}
                            today={today()}
                            action={receiveLineAction}
                            goodsPlan={goodsPlan}
                            canSeeCost={costs}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>Ukupno</td>
                  <td className="num">{integer(qty)}</td>
                  <td className="num">{integer(received)}</td>
                  <td className="num">{integer(Math.max(0, qty - received))}</td>
                  {costs && <td />}
                  {costs && <td className="num">{eur(num(order.total))}</td>}
                  <td />
                </tr>
              </tfoot>
            </table>
          </TableWrap>
          {order.status === 'DRAFT' && canEdit && (
            <p className="text-sm text-fg-3">Roba se zaprima nakon što narudžbenicu pošaljete dobavljaču.</p>
          )}

          <Card title="Primke po narudžbenici" padded={false}>
            {order.receipts.length ? (
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Broj</th>
                    <th>Datum</th>
                    <th>Skladište</th>
                    <th className="num">Kom</th>
                    {costs && <th className="num">Iznos</th>}
                    <th>Status</th>
                    <th>Trošak</th>
                  </tr>
                </thead>
                <tbody>
                  {order.receipts.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link prefetch={false} href={`/nabava/primke/${r.id}`} className="link">
                          {r.number}
                        </Link>
                      </td>
                      <td>{date(r.date)}</td>
                      <td>{r.warehouse.name}</td>
                      <td className="num">{r._count.items}</td>
                      {costs && <td className="num">{eur(num(r.total))}</td>}
                      <td>
                        <Badge tone={RECEIPT_STATUS[r.status].tone}>{RECEIPT_STATUS[r.status].label}</Badge>
                      </td>
                      <td>{r.expense ? <Badge tone="info">knjižen</Badge> : <span className="text-fg-4">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-4 py-3 text-sm text-fg-3">Još ništa nije zaprimljeno.</p>
            )}
          </Card>

          <Card title="Račun dobavljača" actions={<span className="text-xs text-fg-3">nakon primke postaje ulazni račun i ide knjigovođi</span>}>
            <OrderInvoiceForm
              orderId={id}
              orderTotal={costs ? num(order.total) : null}
              readOnly={!canEdit || !costs}
              initial={{
                supplierInvoiceNo: order.supplierInvoiceNo,
                supplierInvoiceDate: order.supplierInvoiceDate ? toISO(order.supplierInvoiceDate) : null,
                supplierInvoiceDueDate: order.supplierInvoiceDueDate ? toISO(order.supplierInvoiceDueDate) : null,
                supplierInvoiceCurrency: order.supplierInvoiceCurrency,
                // iznosi računa dobavljača su nabavna vrijednost — bez prava „costs" ne idu u klijent
                supplierInvoiceNet: !costs || order.supplierInvoiceNet === null ? null : num(order.supplierInvoiceNet),
                supplierInvoiceVat: !costs || order.supplierInvoiceVat === null ? null : num(order.supplierInvoiceVat),
                supplierInvoiceTotal: !costs || order.supplierInvoiceTotal === null ? null : num(order.supplierInvoiceTotal),
              }}
            />
          </Card>

          <Card
            title="Ulazni računi po narudžbenici"
            padded={false}
            actions={
              canEdit && (
                <LinkButton href={`/nabava/ulazni/novi?narudzbenica=${id}`} size="sm" variant="subtle">
                  + Ulazni račun
                </LinkButton>
              )
            }
          >
            {order.supplierInvoices.length ? (
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Interni br.</th>
                    <th>Broj računa</th>
                    <th>Datum</th>
                    {costs && <th className="num">Ukupno</th>}
                    <th>Status</th>
                    <th>Trošak</th>
                  </tr>
                </thead>
                <tbody>
                  {order.supplierInvoices.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link prefetch={false} href={`/nabava/ulazni/${s.id}`} className="link">
                          {s.internalNo}
                        </Link>
                      </td>
                      <td>{s.number}</td>
                      <td>{date(s.issueDate)}</td>
                      {costs && <td className="num">{eur(num(s.total))}</td>}
                      <td>
                        <SupplierInvoiceStatusBadge status={s.status} paid={!!s.paidDate} />
                      </td>
                      <td>{s.expense ? <Badge tone="info">vlastiti trošak</Badge> : <span className="text-fg-3">primkom</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-4 py-3 text-sm text-fg-3">Nema povezanog ulaznog računa.</p>
            )}
          </Card>

          <Card title="Prilozi">
            <Attachments entity="purchaseOrder" id={id} canEdit={canEdit} initial={files} empty="Nema priloga — priložite ponudu ili račun dobavljača (PDF, slika)." />
          </Card>
        </div>

        <Card title="Podaci">
          <dl>
            <Detail label="Dobavljač">{order.supplier.name}</Detail>
            <Detail label="Datum">{date(order.date)}</Detail>
            <Detail label="Očekivana isporuka">{date(order.expectedDate)}</Detail>
            {costs && <Detail label="Iznos (bez PDV-a)">{eur(num(order.total))}</Detail>}
            <Detail label="Upisao">{order.createdBy ?? '—'}</Detail>
            <Detail label="Upisano">{dateTime(order.createdAt)}</Detail>
          </dl>
          {order.note && <p className="mt-3 whitespace-pre-line rounded-md bg-panel-2 p-2.5 text-sm">{order.note}</p>}
        </Card>
      </div>
    </>
  );
}
