import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getLookups, modelLabel } from '@/server/queries/lookups';
import { getItemCard } from '@/server/queries/warehouse';
import { plain } from '@/server/plain';
import { can } from '@/domain/permissions';
import { num } from '@/domain/money';
import { toISO } from '@/domain/dates';
import { warrantyEnd } from '@/domain/pricing';
import { CONTRACT_STATUS_LABEL } from '@/domain/billing';
import { Badge, Card, COLOR_TONE, Detail, Notice, PageHeader } from '@/components/ui/misc';
import { ItemForm } from '@/components/warehouse/item-form';
import { ItemActions } from '@/components/warehouse/item-actions';
import { Attachments } from '@/components/warehouse/attachments';
import { listAttachments } from '@/server/services/attachments';
import { returnOnCost, SERVICE_STATUS_LABEL } from '@/domain/warehouse';
import { date, dateTime, eur, pct } from '@/lib/format';
import { cn } from '@/lib/cn';
import { MdmItemCard } from '@/components/mdm/device-item-card';

type CardData = NonNullable<Awaited<ReturnType<typeof getItemCard>>>;

export default async function ItemCardPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('warehouse', 'view');
  const { id } = await params;
  const [card, lookups, company, files] = await Promise.all([
    getItemCard(user.companyId, id),
    getLookups(user.companyId),
    db.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { statusChangeNeedsApproval: true } }),
    listAttachments(db, user.companyId, 'item', [id]),
  ]);
  // povezani MDM uređaj (samo korisnici vlasnika s pravom na MDM)
  const mdmDevices =
    card && !user.mdmOrgId && can(user.perms, 'mdm', 'view')
      ? await db.mdmDevice.findMany({
          where: { companyId: user.companyId, itemId: id },
          select: { id: true, name: true, platform: true, status: true, lastSeenAt: true, agentVersion: true, org: { select: { name: true, parent: { select: { name: true } } } }, site: { select: { name: true } } },
          take: 5,
        })
      : [];
  if (!card) notFound();
  const { item, contract } = card;

  const perms = { canEdit: can(user.perms, 'warehouse', 'edit'), canOps: can(user.perms, 'warehouse', 'ops'), needsApproval: company.statusChangeNeedsApproval };
  const models = lookups.models.map((m) => ({ value: m.id, label: modelLabel(m) }));
  if (!models.some((m) => m.value === item.modelId)) models.unshift({ value: item.model.id, label: modelLabel(item.model) });
  const options = {
    statuses: lookups.statuses.map((s) => ({ id: s.id, name: s.name, kind: s.kind, color: s.color })),
    warehouses: lookups.warehouses.map((w) => ({ value: w.id, label: w.name })),
    models,
  };
  if (item.warehouse && !options.warehouses.some((w) => w.value === item.warehouse!.id)) options.warehouses.push({ value: item.warehouse.id, label: item.warehouse.name });

  const cost = num(item.cost);
  const months = item.warrantyMonths ?? item.model.warrantyMonths ?? card.defaultWarrantyMonths;
  const wEnd = warrantyEnd(item.warrantyStart ? toISO(item.warrantyStart) : null, months);
  const roc = returnOnCost(card.earned, cost);

  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/skladiste" className="hover:text-fg">
            ← Skladište
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{item.serial}</span>
            <Badge tone={COLOR_TONE[item.status.color] ?? 'neutral'}>{item.status.name}</Badge>
          </span>
        }
        subtitle={[modelLabel(item.model), item.model.category?.name, item.dupNote && `napomena: ${item.dupNote}`].filter(Boolean).join(' · ')}
        actions={<ItemActions itemId={item.id} state={item.state} onContract={!!contract} cost={cost} options={options} perms={perms} />}
      />

      {card.duplicates.length > 0 && (
        <Notice tone="warn">
          Isti serijski broj ima još {card.duplicates.length === 1 ? 'jedan uređaj' : `${card.duplicates.length} uređaja`}:{' '}
          {card.duplicates.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ', '}
              <Link prefetch={false} href={`/skladiste/${d.id}`} className="font-medium underline">
                {d.dupNote || 'bez napomene'}
              </Link>{' '}
              ({d.status.name})
            </span>
          ))}
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <Card title="Podaci uređaja">
            {perms.canEdit ? (
              <ItemForm
                item={plain({
                  id: item.id,
                  serial: item.serial,
                  dupNote: item.dupNote,
                  modelId: item.modelId,
                  warehouseId: item.warehouseId,
                  supplier: item.supplier ? { value: item.supplier.id, label: item.supplier.name } : null,
                  cost: item.cost,
                  rentPrice: item.rentPrice,
                  marginPct: item.marginPct,
                  warrantyMonths: item.warrantyMonths,
                  importDate: item.importDate,
                  note: item.note,
                })}
                models={options.models}
                warehouses={options.warehouses}
                hasDuplicates={card.duplicates.length > 0}
              />
            ) : (
              <dl className="grid gap-x-8 sm:grid-cols-2">
                <Detail label="Serijski broj">{item.serial}</Detail>
                <Detail label="Model">{modelLabel(item.model)}</Detail>
                <Detail label="Skladište">{item.warehouse?.name}</Detail>
                <Detail label="Dobavljač">{item.supplier?.name}</Detail>
                <Detail label="Nabavna cijena">{eur(cost)}</Detail>
                <Detail label="Najam mj.">{item.rentPrice ? eur(num(item.rentPrice)) : null}</Detail>
                <Detail label="Marža">{item.marginPct ? pct(num(item.marginPct)) : null}</Detail>
                <Detail label="Datum uvoza">{date(item.importDate)}</Detail>
                <Detail label="Napomena" className="sm:col-span-2">
                  {item.note}
                </Detail>
              </dl>
            )}
          </Card>

          <Card title="Prilozi">
            <Attachments
              entity="item"
              entityId={item.id}
              initial={files.map((f) => ({ id: f.id, fileName: f.fileName, mime: f.mime, size: f.size }))}
              canAdd={perms.canOps}
              canDelete={perms.canEdit}
              empty="Nema priloga — slike naljepnica dodaju se i pri izlazu iz skladišta."
            />
          </Card>

          <History events={card.events} />
        </div>

        <div className="min-w-0 space-y-4">
          <MdmItemCard devices={mdmDevices} />
          <Card title="Stanje">
            <dl>
              <Detail label="Status">
                <Badge tone={COLOR_TONE[item.status.color] ?? 'neutral'}>{item.status.name}</Badge>
              </Detail>
              <Detail label="Klijent">
                {item.partner ? (
                  <Link prefetch={false} href={`/partneri/${item.partner.id}`} className="link">
                    {item.partner.name}
                  </Link>
                ) : null}
              </Detail>
              <Detail label="Skladište">{item.warehouse?.name}</Detail>
              <Detail label="Račun">
                {item.invoice ? (
                  <Link prefetch={false} href={`/prodaja/racuni/${item.invoice.id}`} className="link">
                    {item.invoice.number ?? 'nacrt'} · {date(item.invoice.date)}
                  </Link>
                ) : null}
              </Detail>
              <Detail label="Datum izdavanja">{item.issueDate ? date(item.issueDate) : null}</Detail>
              <Detail label="Jamstvo do">{wEnd ? <span className={cn(wEnd < toISO(new Date()) && 'text-fg-3 line-through')}>{date(wEnd)}</span> : null}</Detail>
              <Detail label="Primka">
                {item.receipt ? (
                  <Link prefetch={false} href={`/nabava/primke/${item.receipt.id}`} className="link">
                    {item.receipt.number}
                  </Link>
                ) : null}
              </Detail>
              {item.state === 'RESERVED' && (
                <>
                  <Detail label="Izašlo">
                    {dateTime(item.outAt)}
                    {card.outByName && ` · ${card.outByName}`}
                  </Detail>
                  <Detail label="Za">{card.outPartner?.name}</Detail>
                  <Detail label="Napomena izlaza">{item.outNote}</Detail>
                </>
              )}
              {item.state === 'WRITTEN_OFF' && (
                <Detail label="Otpis">
                  {date(item.writeOffDate)} · {item.writeOffReason}
                </Detail>
              )}
            </dl>
          </Card>

          {contract && (
            <Card title="Ugovor o najmu">
              <dl>
                <Detail label="Ugovor">
                  <Link prefetch={false} href={`/najam/ugovori/${contract.id}`} className="link">
                    {contract.number}
                  </Link>
                </Detail>
                <Detail label="Status ugovora">{CONTRACT_STATUS_LABEL[contract.status]}</Detail>
                <Detail label="Trajanje">
                  {date(contract.startDate)} – {contract.endDate ? date(contract.endDate) : 'neodređeno'}
                </Detail>
                <Detail label="Mjesečno">{eur(contract.monthly)}</Detail>
                <Detail label="Naplata">{contract.plan}</Detail>
              </dl>
              {contract.returnReason && item.state === 'RENTED' && (
                <p className="mt-2 rounded-md bg-warn-soft px-2.5 py-1.5 text-sm text-warn">Za povrat: {contract.returnReason}</p>
              )}
            </Card>
          )}

          <Card title="Zarada">
            <dl>
              <Detail label="Zarađeno (računi)">{eur(card.earned)}</Detail>
              <Detail label="Nabavna cijena">{eur(cost)}</Detail>
              <Detail label="Razlika">
                <span className={card.earned - cost >= 0 ? 'text-ok' : 'text-bad-strong'}>{eur(card.earned - cost)}</span>
              </Detail>
              <Detail label="Povrat na nabavnu">{pct(roc)}</Detail>
            </dl>
            <p className="mt-2 text-xs text-fg-3">Zbroj neto stavki izdanih računa s ovim uređajem (bez storniranih), {card.earnedLines} stavki.</p>
          </Card>

          <Card title="Servisni nalozi" padded={!card.serviceOrders.length}>
            {card.serviceOrders.length ? (
              <ul className="divide-y divide-line">
                {card.serviceOrders.map((s) => (
                  <li key={s.id} className="px-4 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <Link prefetch={false} href={`/servis/${s.id}`} className="link font-medium">
                        {s.number}
                      </Link>
                      <Badge tone={s.closedAt ? 'neutral' : 'warn'}>{SERVICE_STATUS_LABEL[s.status] ?? s.status}</Badge>
                    </div>
                    <p className="truncate text-sm text-fg-3">
                      {date(s.reportedAt)} · {s.issue}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-3">Nema servisnih naloga.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

const EVENT_TONE: Record<string, string> = {
  RECEIVED: 'bg-ok',
  SOLD: 'bg-info',
  RENTED: 'bg-info',
  RETURN: 'bg-brand',
  RETURNED: 'bg-brand',
  WRITE_OFF: 'bg-bad-strong',
  SERVICE: 'bg-bad',
  OUT: 'bg-warn',
  ATTACHMENT: 'bg-warn',
  TRANSFER: 'bg-fg-3',
};

function History({ events }: { events: CardData['events'] }) {
  return (
    <Card title="Povijest uređaja">
      {events.length ? (
        <ol className="relative space-y-3 border-l border-line pl-4">
          {events.map((e) => (
            <li key={e.id} className="relative">
              <span className={cn('absolute -left-[21px] top-1.5 size-2.5 rounded-full ring-2 ring-panel', EVENT_TONE[e.type] ?? 'bg-line-strong')} />
              <p className="text-base">
                {e.refType === 'transfer' && e.refId ? (
                  <Link prefetch={false} href={`/skladiste/medjuskladisnice/${e.refId}`} className="hover:underline">
                    {e.message}
                  </Link>
                ) : (
                  e.message
                )}
              </p>
              <p className="text-xs text-fg-3">
                {dateTime(e.at)}
                {e.userName && ` · ${e.userName}`}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-fg-3">Još nema zapisa.</p>
      )}
    </Card>
  );
}
