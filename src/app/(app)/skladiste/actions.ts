'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { audit, diff } from '@/server/audit';
import { needsStatusApproval } from '@/domain/permissions';
import { DomainError } from '@/server/errors';
import { canSeeCost } from '@/domain/permissions';
import { itemEvents } from '@/server/services/items';
import { addAttachments, photoBytes, withPhotos, zPhotos } from '@/server/services/attachments';
import { zBool, zId, zIds, zMoney, zOptDate, zOptId, zOptInt, zOptMoney, zOptText, zReq } from '@/server/zod';
import {
  announceReturn, applyStatusChange, bulkEdit, deleteItems, markOut, requestStatusChange, transferItems, updateItem, writeOff,
} from '@/server/services/warehouse';
import { escapeLike } from '@/lib/like';

const kom = (n: number) => `${n} kom`;

export const changeStatus = action(
  { module: 'warehouse', level: 'ops' },
  z.object({ itemIds: zIds, statusId: zId, note: zOptText, warehouseId: zOptId }),
  async (input, user) =>
    transaction(async (tx) => {
      // odobrenje po korisniku (F8): User.requireApproval, inače pravilo firme za korisnike bez punog prava
      if (user.role !== 'ADMIN') {
        const company = await tx.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { statusChangeNeedsApproval: true } });
        if (needsStatusApproval(user, company.statusChangeNeedsApproval)) {
          const r = await requestStatusChange(tx, user, input);
          await audit(tx, user, {
            entity: 'approvalRequest',
            entityId: r.id,
            action: 'create',
            summary: `Zahtjev za promjenu statusa (${kom(input.itemIds.length)})`,
          });
          return { message: 'Zahtjev za promjenu statusa poslan je na odobrenje.' };
        }
      }
      const res = await applyStatusChange(tx, user, input);
      await audit(tx, user, {
        entity: 'item',
        entityId: input.itemIds.length === 1 ? input.itemIds[0] : null,
        action: 'status',
        summary: `Promjena statusa (${kom(res.count)})`,
        diff: { itemIds: input.itemIds, statusId: input.statusId },
      });
      return { message: `Status promijenjen (${kom(res.count)}).` };
    }),
);

export const transferAction = action(
  { module: 'warehouse', level: 'edit' },
  z.object({ itemIds: zIds, toWarehouseId: zId, date: zOptDate, note: zOptText }),
  async (input, user) =>
    transaction(async (tx) => {
      const r = await transferItems(tx, user, input);
      await audit(tx, user, {
        entity: 'transfer',
        entityId: r.transferIds[0],
        action: 'create',
        summary: `Međuskladišnica ${r.numbers.join(', ')} → ${r.to} (${kom(r.count)})`,
      });
      const skipped = r.skipped ? ` ${kom(r.skipped)} već je bilo u odredišnom skladištu.` : '';
      return {
        message: `Premješteno ${kom(r.count)} — ${r.numbers.join(', ')}.${skipped}`,
        data: { transferIds: r.transferIds },
      };
    }),
);

/** Izlaz iz skladišta; uz njega neobavezne slike naljepnica — svaka postaje prilog svog uređaja. */
export const markOutAction = action(
  { module: 'warehouse', level: 'ops' },
  withPhotos(z.object({ itemIds: zIds, partnerId: zOptId, note: zOptText, photos: zPhotos })),
  async ({ photos, ...input }, user) => {
    const files = await photoBytes(photos);
    return transaction(async (tx) => {
      const r = await markOut(tx, user, input);
      const ids = new Set(input.itemIds);
      const byItem = new Map<string, typeof files>();
      for (const f of files) {
        if (!f.target || !ids.has(f.target)) throw new DomainError('Slika nije povezana s uređajem koji izlazi.');
        byItem.set(f.target, [...(byItem.get(f.target) ?? []), f]);
      }
      if (byItem.size) {
        const serials = new Map((await tx.item.findMany({ where: { id: { in: [...byItem.keys()] }, companyId: user.companyId }, select: { id: true, serial: true } })).map((i) => [i.id, i.serial]));
        for (const [itemId, list] of byItem) {
          await addAttachments(tx, user, 'item', itemId, list.map((f) => ({ fileName: `Izlaz ${serials.get(itemId) ?? ''}`, data: f.data })));
        }
        await itemEvents(tx, user, [...byItem.keys()], { type: 'ATTACHMENT', message: 'Priložena slika naljepnice pri izlazu iz skladišta' });
      }
      await audit(tx, user, {
        entity: 'item',
        action: 'out',
        summary: `Izlaz iz skladišta (${kom(r.count)})${files.length ? `, slika: ${files.length}` : ''}`,
        diff: { itemIds: input.itemIds },
      });
      return { message: `Označeno kao izašlo iz skladišta (${kom(r.count)})${files.length ? ` — priloženo slika: ${files.length}` : ''}.` };
    });
  },
);

export const writeOffAction = action(
  { module: 'warehouse', level: 'edit' },
  z.object({ itemIds: zIds, reason: zReq('Razlog'), note: zOptText, bookExpense: zBool, date: zOptDate }),
  async (input, user) =>
    transaction(async (tx) => {
      const r = await writeOff(tx, user, input);
      await audit(tx, user, {
        entity: 'item',
        action: 'writeOff',
        summary: `Otpis ${kom(r.count)} — ${input.reason}${r.expenseId ? `, trošak ${r.total.toFixed(2)} €` : ''}`,
        diff: { itemIds: input.itemIds },
      });
      return { message: `Otpisano ${kom(r.count)}.${r.expenseId ? ' Knjižen je trošak otpisa.' : ''}` };
    }),
);

const optField = <T extends z.ZodTypeAny>(s: T) => s.optional();

export const bulkEditAction = action(
  { module: 'warehouse', level: 'edit' },
  z.object({
    itemIds: zIds,
    warehouseId: optField(zId),
    supplierId: optField(zOptId),
    // prazno polje je null (ne 0) — servis ga odbija
    cost: optField(zOptMoney),
    modelId: optField(zId),
    note: optField(zOptText),
    partnerId: optField(zOptId),
    marginPct: optField(zOptMoney),
  }),
  async (input, user) =>
    transaction(async (tx) => {
      // nabavna cijena i marža samo uz pravo na nabavne cijene
      if ((input.cost !== undefined || input.marginPct !== undefined) && !canSeeCost(user.perms)) throw new DomainError('Nemate pravo mijenjati nabavne cijene i marže.');
      const r = await bulkEdit(tx, user, input);
      await audit(tx, user, { entity: 'item', action: 'bulkUpdate', summary: `Grupna izmjena (${kom(r.count)}): ${r.summary}`, diff: { itemIds: input.itemIds, transferIds: r.transferIds } });
      return { message: `Izmijenjeno ${kom(r.count)}.` };
    }),
);

export const announceReturnAction = action(
  { module: 'warehouse', level: 'ops' },
  z.object({ itemIds: zIds, note: zOptText }),
  async (input, user) =>
    transaction(async (tx) => {
      const r = await announceReturn(tx, user, input.itemIds, input.note);
      await audit(tx, user, { entity: 'item', action: 'returning', summary: `Najavljen povrat (${kom(r.count)})`, diff: { itemIds: input.itemIds } });
      return { message: `Najavljen povrat (${kom(r.count)}).` };
    }),
);

export const updateItemAction = action(
  { module: 'warehouse', level: 'edit' },
  z.object({
    id: zId,
    serial: zReq('Serijski broj'),
    dupNote: zOptText,
    modelId: zReq('Model'),
    warehouseId: zOptId,
    supplierId: zOptId,
    cost: optField(zMoney),
    rentPrice: zOptMoney,
    marginPct: optField(zOptMoney),
    warrantyMonths: zOptInt,
    importDate: zOptDate,
    note: zOptText,
    // ručni ispravci s kartice (E6); polje koje obrazac ne šalje ostaje kakvo jest
    cpu: optField(zOptText),
    screen: optField(zOptText),
    os: optField(zOptText),
    categoryId: optField(zOptId),
    salePrice: optField(zOptMoney),
    issueDate: optField(zOptDate),
    invoiceId: optField(zOptId),
    partnerId: optField(zOptId),
  }),
  async ({ id, ...raw }, user) =>
    transaction(async (tx) => {
      // bez prava na nabavne cijene nabavna i marža se ne mijenjaju (obrazac ih ni ne prikazuje)
      const input = canSeeCost(user.perms) ? raw : { ...raw, cost: undefined, marginPct: undefined };
      const r = await updateItem(tx, user, id, input);
      if (r.transfer) {
        await audit(tx, user, {
          entity: 'transfer',
          entityId: r.transfer.transferIds[0],
          action: 'create',
          summary: `Međuskladišnica ${r.transfer.numbers.join(', ')} → ${r.transfer.to} (uređaj ${input.serial})`,
        });
      }
      if (r.changed.length) {
        await audit(tx, user, {
          entity: 'item',
          entityId: id,
          action: 'update',
          summary: `Uređaj ${input.serial} izmijenjen`,
          diff: JSON.parse(JSON.stringify(diff(r.before as unknown as Record<string, unknown>, r.after))),
        });
      }
      return { message: r.changed.length ? 'Spremljeno.' : 'Nema promjena.' };
    }),
);

/** Brisanje uređaja bez računa, ugovora, međuskladišnice i servisa (pojedinačno ili skupno). */
export const deleteItemsAction = action({ module: 'warehouse', level: 'edit' }, z.object({ itemIds: zIds, back: zBool }), async ({ itemIds, back }, user) =>
  transaction(async (tx) => {
    const r = await deleteItems(tx, user, itemIds);
    await audit(tx, user, {
      entity: 'item',
      entityId: r.count === 1 ? itemIds[0] : null,
      action: 'delete',
      summary: `Obrisano uređaja: ${r.count} (${r.serials.slice(0, 20).join(', ')}${r.count > 20 ? '…' : ''})`,
      diff: { itemIds, serials: r.serials },
    });
    const note = r.fromReceipt ? ' Primka i trošak nabave ostaju — za povrat robe dobavljaču stornirajte primku.' : '';
    return { message: `Obrisano ${kom(r.count)}.${note}`, ...(back ? { redirect: '/skladiste' } : {}) };
  }),
);

/** Računi za ručnu vezu s karticom uređaja (pretraga po broju ili kupcu). */
export const searchInvoicesForItem = action({ module: 'warehouse', level: 'edit' }, z.object({ q: zOptText, itemId: zId }), async ({ q, itemId }, user) => {
  // nude se samo izdani računi na kojima je ovaj uređaj stavka (ostalo updateItem odbija)
  const rows = await db.invoice.findMany({
    where: {
      companyId: user.companyId,
      status: 'ISSUED',
      number: { not: null },
      lines: { some: { itemId } },
      ...(q ? { OR: [{ number: { contains: escapeLike(q), mode: 'insensitive' } }, { partner: { name: { contains: escapeLike(q), mode: 'insensitive' } } }] } : {}),
    },
    orderBy: [{ date: 'desc' }],
    take: 30,
    select: { id: true, number: true, date: true, partner: { select: { name: true } } },
  });
  return { data: rows.map((r) => ({ value: r.id, label: r.number ?? '—', hint: `${r.partner.name} · ${r.date.toISOString().slice(0, 10)}` })), revalidate: [] };
});

