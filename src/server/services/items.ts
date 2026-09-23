import 'server-only';
import type { Prisma, StatusKind } from '@prisma/client';
import type { Tx } from '../db';
import type { SessionUser } from '../auth';
import { DomainError } from '../errors';
import { nextDocNumber } from '../numbering';
import { fromISO, today } from '@/domain/dates';

export type Actor = Pick<SessionUser, 'id' | 'name' | 'companyId'>;

export const STATUS_KIND_LABEL: Record<StatusKind, string> = {
  IN_STOCK: 'Na skladištu',
  RESERVED: 'Izašlo iz skladišta',
  SOLD: 'Prodan',
  RENTED: 'U najmu',
  SERVICE: 'Na servisu',
  RETURNING: 'U dolasku',
  WRITTEN_OFF: 'Otpisan',
  OTHER: 'Ostalo',
};

/** Sistemski status za vrstu (npr. „Na skladištu" za IN_STOCK). */
export async function statusFor(tx: Tx, companyId: string, kind: StatusKind) {
  const st =
    (await tx.itemStatus.findFirst({ where: { companyId, kind, system: true } })) ??
    (await tx.itemStatus.findFirst({ where: { companyId, kind }, orderBy: { sort: 'asc' } }));
  if (!st) throw new DomainError(`Nedostaje status vrste „${STATUS_KIND_LABEL[kind]}" — dodajte ga u Postavke → Šifrarnici.`);
  return st;
}

export interface StatusChange {
  /** Status po id-u ili po vrsti (sistemski status te vrste). */
  statusId?: string;
  kind?: StatusKind;
  /** Dodatna polja koja se upisuju uz promjenu (kupac, račun, skladište…). */
  data?: Prisma.ItemUncheckedUpdateManyInput;
  event: { type: string; message: string; refType?: string; refId?: string };
}

/**
 * Jedina točka promjene statusa uređaja. Čuva pravila koja u starom programu
 * nisu bila zajamčena:
 *   • uređaj na skladištu ne pripada nikome (briše kupca, račun, ugovor, jamstvo)
 *   • trag izlaza iz skladišta postoji samo dok je uređaj „izašao"
 *   • uređaj koji nije u najmu ni u dolasku skida se s ugovora
 *   • status vrste SERVICE otvara servisni nalog ako otvorenog nema
 *   • svaka promjena ostavlja zapis u povijesti uređaja
 */
export async function changeItemStatus(tx: Tx, actor: Actor, itemIds: string[], change: StatusChange) {
  if (!itemIds.length) return { count: 0, kind: null as StatusKind | null };
  const status = change.statusId
    ? await tx.itemStatus.findFirst({ where: { id: change.statusId, companyId: actor.companyId } })
    : await statusFor(tx, actor.companyId, change.kind!);
  if (!status) throw new DomainError('Status ne postoji.');

  const items = await tx.item.findMany({
    where: { id: { in: itemIds }, companyId: actor.companyId },
    select: { id: true, serial: true, state: true, partnerId: true, invoiceId: true, contractItem: { select: { contractId: true } } },
  });
  if (items.length !== new Set(itemIds).size) throw new DomainError('Neki od odabranih uređaja ne postoje.');

  const kind = status.kind;
  const data: Prisma.ItemUncheckedUpdateManyInput = { ...change.data, statusId: status.id, state: kind };
  if (kind === 'IN_STOCK') {
    Object.assign(data, { partnerId: null, issueDate: null, invoiceId: null, salePrice: null, warrantyStart: null });
  }
  if (kind !== 'RESERVED') Object.assign(data, { outAt: null, outById: null, outPartnerId: null, outNote: null });

  await tx.item.updateMany({ where: { id: { in: itemIds }, companyId: actor.companyId }, data });

  // skidanje s ugovora — samo najam i povrat ostaju vezani
  if (kind !== 'RENTED' && kind !== 'RETURNING') {
    const onContract = items.filter((i) => i.contractItem);
    if (onContract.length) {
      await tx.contractItem.deleteMany({ where: { itemId: { in: onContract.map((i) => i.id) } } });
      await tx.itemEvent.createMany({
        data: onContract.map((i) => ({
          companyId: actor.companyId,
          itemId: i.id,
          type: 'CONTRACT',
          message: `Skinut s ugovora — status promijenjen u „${status.name}"`,
          refType: 'contract',
          refId: i.contractItem!.contractId,
          userName: actor.name,
        })),
      });
    }
  }

  await tx.itemEvent.createMany({
    data: items.map((i) => ({
      companyId: actor.companyId,
      itemId: i.id,
      type: change.event.type,
      message: change.event.message.replace('{status}', status.name),
      refType: change.event.refType ?? null,
      refId: change.event.refId ?? null,
      userName: actor.name,
    })),
  });

  if (kind === 'SERVICE') await openServiceOrders(tx, actor, items, status.name);

  return { count: items.length, kind };
}

async function openServiceOrders(
  tx: Tx,
  actor: Actor,
  items: Array<{ id: string; serial: string; partnerId: string | null; invoiceId: string | null }>,
  statusName: string,
) {
  const open = await tx.serviceOrder.findMany({
    where: { companyId: actor.companyId, itemId: { in: items.map((i) => i.id) }, status: { in: ['REPORTED', 'RECEIVED', 'DIAGNOSIS', 'AT_SUPPLIER'] } },
    select: { itemId: true },
  });
  const has = new Set(open.map((o) => o.itemId));
  const t = today();
  for (const i of items) {
    if (has.has(i.id)) continue;
    const number = await nextDocNumber(tx, actor.companyId, 'SERVICE', Number(t.slice(0, 4)));
    await tx.serviceOrder.create({
      data: {
        companyId: actor.companyId,
        number,
        itemId: i.id,
        serial: i.serial,
        partnerId: i.partnerId,
        invoiceId: i.invoiceId,
        status: 'RECEIVED',
        reportedAt: fromISO(t),
        receivedAt: fromISO(t),
        issue: 'Nije upisano',
        note: `Automatski otvoreno — status uređaja promijenjen u „${statusName}"`,
        timeline: [{ at: new Date().toISOString(), status: 'RECEIVED', by: actor.name, note: 'Nalog otvoren automatski' }],
        createdBy: actor.name,
      },
    });
  }
}

/** Zapis u povijest uređaja bez promjene statusa. */
export async function itemEvents(
  tx: Tx,
  actor: Actor,
  itemIds: string[],
  event: { type: string; message: string; refType?: string; refId?: string },
) {
  if (!itemIds.length) return;
  await tx.itemEvent.createMany({
    data: itemIds.map((itemId) => ({
      companyId: actor.companyId,
      itemId,
      type: event.type,
      message: event.message,
      refType: event.refType ?? null,
      refId: event.refId ?? null,
      userName: actor.name,
    })),
  });
}
