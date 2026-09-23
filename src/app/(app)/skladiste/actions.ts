'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { audit, diff } from '@/server/audit';
import { can } from '@/domain/permissions';
import { zBool, zId, zIds, zMoney, zOptDate, zOptId, zOptInt, zOptMoney, zOptText, zReq } from '@/server/zod';
import {
  announceReturn, applyStatusChange, bulkEdit, markOut, requestStatusChange, transferItems, updateItem, writeOff,
} from '@/server/services/warehouse';

const kom = (n: number) => `${n} kom`;

export const changeStatus = action(
  { module: 'warehouse', level: 'ops' },
  z.object({ itemIds: zIds, statusId: zId, note: zOptText, warehouseId: zOptId }),
  async (input, user) =>
    transaction(async (tx) => {
      if (!can(user.perms, 'warehouse', 'edit')) {
        const company = await tx.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { statusChangeNeedsApproval: true } });
        if (company.statusChangeNeedsApproval) {
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

export const markOutAction = action(
  { module: 'warehouse', level: 'ops' },
  z.object({ itemIds: zIds, partnerId: zOptId, note: zOptText }),
  async (input, user) =>
    transaction(async (tx) => {
      const r = await markOut(tx, user, input);
      await audit(tx, user, { entity: 'item', action: 'out', summary: `Izlaz iz skladišta (${kom(r.count)})`, diff: { itemIds: input.itemIds } });
      return { message: `Označeno kao izašlo iz skladišta (${kom(r.count)}).` };
    }),
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
    cost: optField(zMoney),
    modelId: optField(zId),
    note: optField(zOptText),
  }),
  async (input, user) =>
    transaction(async (tx) => {
      const r = await bulkEdit(tx, user, input);
      await audit(tx, user, { entity: 'item', action: 'bulkUpdate', summary: `Grupna izmjena (${kom(r.count)}): ${r.summary}`, diff: { itemIds: input.itemIds } });
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
    cost: zMoney,
    rentPrice: zOptMoney,
    marginPct: zOptMoney,
    warrantyMonths: zOptInt,
    importDate: zOptDate,
    note: zOptText,
  }),
  async ({ id, ...input }, user) =>
    transaction(async (tx) => {
      const r = await updateItem(tx, user, id, input);
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

/** Pretraga partnera za padajuće izbornike (bez slanja cijelog popisa u preglednik). */
export const searchPartners = action(
  { module: 'warehouse', level: 'view' },
  z.object({ q: zOptText, role: z.enum(['customer', 'supplier', 'any']).default('any') }),
  async ({ q, role }, user) => {
    const rows = await db.partner.findMany({
      where: {
        companyId: user.companyId,
        ...(role === 'customer' ? { isCustomer: true } : role === 'supplier' ? { isSupplier: true } : {}),
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { oib: { startsWith: q } }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: 40,
      select: { id: true, name: true, city: true },
    });
    // samo čitanje — bez osvježavanja prikaza
    return { data: rows.map((p) => ({ value: p.id, label: p.name, hint: p.city ?? undefined })), revalidate: [] };
  },
);
