'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { assert } from '@/server/errors';
import { zBool, zDate, zId, zInt, zMoney, zOptDate, zOptId, zOptMoney, zOptText, zText } from '@/server/zod';
import { canSeeCost } from '@/domain/permissions';
import { deleteOrder, receiveGoods, saveOrder, setOrderStatus } from '@/server/services/purchasing';
import { parseSerials } from '@/components/purchasing/labels';
import { saveOrderInvoice } from '@/server/services/supplier-invoices';

const orderSchema = z.object({
  id: zOptId,
  supplierId: zId,
  date: zDate,
  expectedDate: zOptDate,
  note: zOptText,
  lines: z.array(z.object({ id: zOptId, modelId: zId, qty: zInt, unitCost: zMoney })).min(1, 'Dodajte barem jednu stavku.'),
});

export const saveOrderAction = action({ module: 'purchasing', level: 'edit' }, orderSchema, async ({ id, ...input }, user) =>
  transaction(async (tx) => {
    const o = await saveOrder(tx, user, id, input);
    return { message: `Narudžbenica ${o.number} spremljena.`, redirect: `/nabava/narudzbenice/${o.id}` };
  }),
);

export const orderStatusAction = action(
  { module: 'purchasing', level: 'edit' },
  z.object({ id: zId, to: z.enum(['ORDERED', 'CANCELLED', 'DRAFT']) }),
  async ({ id, to }, user) =>
    transaction(async (tx) => {
      await setOrderStatus(tx, user, id, to);
      return { message: { ORDERED: 'Narudžbenica je poslana dobavljaču.', CANCELLED: 'Narudžbenica je otkazana.', DRAFT: 'Narudžbenica je vraćena u nacrt.' }[to] };
    }),
);

export const deleteOrderAction = action({ module: 'purchasing', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    await deleteOrder(tx, user, id);
    return { message: 'Narudžbenica je obrisana.', redirect: '/nabava/narudzbenice' };
  }),
);

export const receiveLineAction = action(
  { module: 'purchasing', level: 'edit' },
  z.object({
    orderId: zId,
    lineId: zId,
    warehouseId: zId,
    date: zDate,
    unitCost: zMoney,
    supplierDocNumber: zOptText,
    serials: zText,
    bookExpense: zBool.optional(),
  }),
  async (input, user) =>
    transaction(async (tx) => {
      const line = await tx.purchaseOrderLine.findFirst({
        where: { id: input.lineId, orderId: input.orderId, order: { companyId: user.companyId } },
        select: { modelId: true, unitCost: true },
      });
      assert(line, 'Stavka narudžbenice ne postoji.');
      const r = await receiveGoods(tx, user, {
        orderId: input.orderId,
        warehouseId: input.warehouseId,
        date: input.date,
        supplierDocNumber: input.supplierDocNumber,
        bookExpense: input.bookExpense,
        lines: [{ modelId: line.modelId, unitCost: canSeeCost(user.perms) ? input.unitCost : Number(line.unitCost), serials: parseSerials(input.serials), orderLineId: input.lineId }],
      });
      return { message: `Primka ${r.number}: zaprimljeno ${r.count} kom.${r.booked ? '' : ' Trošak nabave nije knjižen.'}`, data: r };
    }),
);

/** Račun dobavljača upisan na narudžbenici (broj, datum, dospijeće, valuta, osnovica, PDV); po zaprimanju postaje ulazni račun. */
export const saveOrderInvoiceAction = action(
  { module: 'purchasing', level: 'edit' },
  z.object({
    orderId: zId,
    supplierInvoiceNo: zOptText,
    supplierInvoiceDate: zOptDate,
    supplierInvoiceDueDate: zOptDate,
    supplierInvoiceCurrency: zOptText,
    supplierInvoiceNet: zOptMoney,
    supplierInvoiceVat: zOptMoney,
    supplierInvoiceTotal: zOptMoney,
  }),
  async ({ orderId, ...input }, user) =>
    transaction(async (tx) => {
      const siId = await saveOrderInvoice(tx, user, orderId, input);
      return { message: siId ? 'Račun dobavljača spremljen — povezan je ulazni račun.' : 'Račun dobavljača spremljen. Ulazni račun nastaje kad se roba zaprimi.' };
    }),
);
