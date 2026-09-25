import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileText, Printer, Trash2, Truck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getLookups, modelLabel } from '@/server/queries/lookups';
import { deviceWarrantyEnd, getServiceOrder } from '@/server/queries/service';
import { previousState } from '@/server/services/service';
import { STATUS_KIND_LABEL } from '@/server/services/items';
import { can } from '@/domain/permissions';
import { daysBetween, formatDate, toISO, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { Badge, COLOR_TONE, Card, Detail, PageHeader } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { PdfButton } from '@/components/ui/pdf-button';
import { SendEmailButton } from '@/components/ui/send-email-button';
import { ServiceEditForm } from '@/components/service/service-edit-form';
import { ReplaceDialog, ReturnDialog, StatusControl } from '@/components/service/service-actions';
import { Timeline } from '@/components/service/timeline';
import { LONG_SERVICE_DAYS, SERVICE_STATUS, isOpenService, type TimelineEntry } from '@/components/service/labels';
import { eur } from '@/lib/format';
import { ActionButton } from '@/components/ui/action';
import { Attachments } from '@/components/ui/attachments';
import { plain } from '@/server/plain';
import { canAttachment, listAttachments } from '@/server/services/attachments';
import { deleteServiceAction, replaceDeviceAction, returnDeviceAction, searchDevicesAction, serviceStatusAction, updateServiceAction } from '../actions';

export default async function ServiceOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('service', 'view');
  const { id } = await params;
  const [o, lookups, photos] = await Promise.all([
    getServiceOrder(user.companyId, id),
    getLookups(user.companyId),
    listAttachments(db, user.companyId, 'serviceOrder', [id]),
  ]);
  if (!o) notFound();
  const canEdit = can(user.perms, 'service', 'edit');
  const timeline = (Array.isArray(o.timeline) ? o.timeline : []) as unknown as TimelineEntry[];
  const open = isOpenService(o.status);
  const st = SERVICE_STATUS[o.status];
  const item = o.item;
  const days = daysBetween(toISO(o.reportedAt), o.closedAt ? toISO(o.closedAt) : today());
  const wEnd = item ? deviceWarrantyEnd(item) : null;
  const warehouses = lookups.warehouses.map((w) => ({ value: w.id, label: w.name }));

  // povrat: ciljevi prema stanju prije servisa
  const prev = item ? await previousState(db, o, item) : null;
  const partnerId = item?.partnerId ?? prev?.partnerId ?? null;
  const contractKnown = !!(item?.contractItem || prev?.contract);
  const returnOptions = [
    // „prodan" samo ako je uređaj prije servisa bio prodan (kao i kod zamjene)
    ...(partnerId && prev?.state === 'SOLD' ? [{ value: 'SOLD' as const, label: `Kupcu (${o.partner?.name ?? 'klijent'}) — prodan` }] : []),
    ...(contractKnown ? [{ value: 'RENTED' as const, label: 'Natrag u najam (isti ugovor)' }] : []),
    { value: 'IN_STOCK' as const, label: 'Na skladište' },
  ];
  const defaultTarget = prev?.state === 'RENTED' && contractKnown ? 'RENTED' : prev?.state === 'SOLD' && partnerId ? 'SOLD' : 'IN_STOCK';
  const canReturn = canEdit && o.status === 'REPAIRED' && item?.state === 'SERVICE';
  const canReplace = canEdit && item && partnerId && (open || (o.status === 'REPAIRED' && item.state === 'SERVICE'));

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Servisni nalog {o.number} <Badge tone={st.tone}>{st.label}</Badge>
            {o.source === 'PORTAL' && (
              <Badge tone="brand" title="Kvar je prijavio klijent kroz portal">
                portal
              </Badge>
            )}
          </span>
        }
        subtitle={`${o.serial ?? ''}${item ? ` · ${modelLabel(item.model)}` : ''}${o.partner ? ` · ${o.partner.name}` : ''}`}
        back={
          <Link prefetch={false} href="/servis" className="hover:text-fg">
            ← Servis
          </Link>
        }
        actions={
          <>
            <LinkButton href={`/servis/${id}/ispis`} icon={<Printer className="size-4" />}>
              Servisni nalog
            </LinkButton>
            <LinkButton href={`/servis/${id}/ispis?vrsta=dostava`} icon={<Truck className="size-4" />}>
              Nalog za dostavu
            </LinkButton>
            <PdfButton kind={open ? 'service' : 'service-delivery'} id={id} send={canEdit} />
            {canEdit && <SendEmailButton kind="service" id={id} />}
            {canEdit && o.status !== 'REPLACED' && o.status !== 'WRITTEN_OFF' && !o.invoice && (
              <ActionButton
                action={deleteServiceAction}
                input={{ id }}
                variant="ghost"
                className="text-bad-strong"
                icon={<Trash2 className="size-4" />}
                confirmTitle={`Obrisati nalog ${o.number}?`}
                confirmLabel="Obriši nalog"
                confirm="Nalog se briše s tijekom i fotografijama (npr. otvoren greškom ili dvostruka prijava). Nalog po kojem je uređaj još na servisu ne može se obrisati — uređaj prvo vratite."
              >
                Obriši
              </ActionButton>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          {canEdit && (
            <Card title="Status">
              <StatusControl id={id} current={o.status} hasItem={!!item} action={serviceStatusAction} />
            </Card>
          )}
          <Card title="Nalog">
            <ServiceEditForm
              readOnly={!canEdit}
              action={updateServiceAction}
              value={{
                id,
                issue: o.issue,
                diagnosis: o.diagnosis,
                action: o.action,
                solution: o.solution,
                cost: num(o.cost),
                underWarranty: o.underWarranty,
                publicNote: o.publicNote,
                note: o.note,
                reportedAt: toISO(o.reportedAt),
                receivedAt: o.receivedAt ? toISO(o.receivedAt) : null,
              }}
            />
          </Card>
          <Card title="Fotografije i dokumenti">
            <Attachments
              entity="serviceOrder"
              id={id}
              canEdit={canAttachment(user.perms, 'serviceOrder', 'add')}
              initial={plain(photos)}
              empty="Nema fotografija — dodajte slike kvara, naljepnice ili dokumente."
            />
          </Card>
          <Card title="Tijek naloga">
            <Timeline entries={timeline} />
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Uređaj">
            {item ? (
              <dl>
                <Detail label="Serijski broj">
                  <Link prefetch={false} href={`/skladiste/${item.id}`} className="link font-mono">
                    {item.serial}
                  </Link>
                </Detail>
                <Detail label="Model">{modelLabel(item.model)}</Detail>
                <Detail label="Status">
                  <Badge tone={COLOR_TONE[item.status.color] ?? 'neutral'}>{item.status.name}</Badge>
                </Detail>
                {item.warehouse && <Detail label="Skladište">{item.warehouse.name}</Detail>}
                {item.contractItem && (
                  <Detail label="Ugovor">
                    <Link prefetch={false} href={`/najam/ugovori/${item.contractItem.contractId}`} className="link">
                      {item.contractItem.contract.number}
                    </Link>
                  </Detail>
                )}
                {!item.contractItem && prev?.contract && <Detail label="Prije servisa">u najmu (uređaj je skinut s ugovora)</Detail>}
                <Detail label="Jamstvo do">
                  {wEnd ? <span className={wEnd >= today() ? 'text-ok' : 'text-bad-strong'}>{formatDate(wEnd)}</span> : '—'}
                </Detail>
                {item.supplier && <Detail label="Dobavljač">{item.supplier.name}</Detail>}
              </dl>
            ) : (
              <p className="text-sm text-fg-3">Uređaj {o.serial} više ne postoji u evidenciji.</p>
            )}
          </Card>

          <Card title="Podaci">
            <dl>
              <Detail label="Klijent">
                {o.partner ? (
                  <Link prefetch={false} href={`/partneri/${o.partner.id}`} className="link">
                    {o.partner.name}
                  </Link>
                ) : (
                  '—'
                )}
              </Detail>
              {o.invoice && (
                <Detail label="Izvorni račun">
                  <Link prefetch={false} href={`/prodaja/racuni/${o.invoice.id}`} className="link">
                    {o.invoice.number ?? 'nacrt'}
                  </Link>
                </Detail>
              )}
              {o.source === 'PORTAL' && <Detail label="Izvor">portal za klijente</Detail>}
              {o.contact && <Detail label="Kontakt">{o.contact}</Detail>}
              <Detail label="Prijavljeno">{formatDate(o.reportedAt)}</Detail>
              <Detail label="Zaprimljeno">{formatDate(o.receivedAt)}</Detail>
              <Detail label="Zatvoreno">{formatDate(o.closedAt)}</Detail>
              <Detail label="Dana na servisu">
                <span className={open && days > LONG_SERVICE_DAYS ? 'font-semibold text-bad-strong' : undefined}>{days}</span>
              </Detail>
              <Detail label="Trošak">{eur(num(o.cost))}</Detail>
              <Detail label="Jamstvo">{o.underWarranty ? 'da' : 'ne'}</Detail>
              {o.replacement && (
                <Detail label="Zamjenski uređaj">
                  <Link prefetch={false} href={`/skladiste/${o.replacement.id}`} className="link font-mono">
                    {o.replacement.serial}
                  </Link>
                </Detail>
              )}
              <Detail label="Otvorio">{o.createdBy ?? '—'}</Detail>
            </dl>
          </Card>

          {(canReturn || canReplace) && (
            <Card title="Uređaj klijentu">
              <div className="space-y-2">
                {canReturn && (
                  <ReturnDialog
                    id={id}
                    options={returnOptions}
                    defaultTarget={defaultTarget}
                    warehouses={warehouses}
                    defaultWarehouseId={prev?.warehouseId ?? item?.warehouseId ?? null}
                    action={returnDeviceAction}
                  />
                )}
                {canReplace && item && (
                  <ReplaceDialog
                    id={id}
                    itemId={item.id}
                    search={searchDevicesAction}
                    warehouses={warehouses}
                    kindLabel={contractKnown ? STATUS_KIND_LABEL.RENTED : STATUS_KIND_LABEL.SOLD}
                    action={replaceDeviceAction}
                  />
                )}
              </div>
              {o.status !== 'REPAIRED' && item?.state === 'SERVICE' && (
                <p className="mt-2 text-xs text-fg-3">
                  <FileText className="mr-1 inline size-3" />
                  „Vrati uređaj" je dostupno kad je nalog u statusu „Popravljeno".
                </p>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
