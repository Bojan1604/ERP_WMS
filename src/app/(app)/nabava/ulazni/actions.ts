'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zDate, zId, zIds, zMoney, zOptDate, zOptId, zOptMoney, zOptText, zReq } from '@/server/zod';
import { deleteSupplierInvoice, saveSupplierInvoice, setSupplierInvoicesPaid } from '@/server/services/expenses';

const schema = z.object({
  id: zOptId,
  supplierId: zId,
  number: zReq('Broj računa'),
  issueDate: zDate,
  dueDate: zOptDate,
  netAmount: zMoney,
  vatAmount: zMoney,
  total: zOptMoney,
  category: zOptText,
  note: zOptText,
  paidDate: zOptDate,
  book: zBool,
});

export const saveSupplierInvoiceAction = action({ module: 'purchasing', level: 'edit' }, schema, async ({ id, ...input }, user) =>
  transaction(async (tx) => {
    const si = await saveSupplierInvoice(tx, user, id, input);
    return { message: `Ulazni račun ${si.internalNo} spremljen.`, redirect: '/nabava/ulazni' };
  }),
);

export const supplierInvoicesPaidAction = action(
  { module: 'purchasing', level: 'edit' },
  z.object({ ids: zIds, paidDate: zOptDate }),
  async ({ ids, paidDate }, user) =>
    transaction(async (tx) => {
      const n = await setSupplierInvoicesPaid(tx, user, ids, paidDate);
      return { message: `${n} računa označeno kao ${paidDate ? 'plaćeno' : 'neplaćeno'}.` };
    }),
);

export const deleteSupplierInvoiceAction = action({ module: 'purchasing', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    await deleteSupplierInvoice(tx, user, id);
    return { message: 'Ulazni račun je obrisan.', redirect: '/nabava/ulazni' };
  }),
);
