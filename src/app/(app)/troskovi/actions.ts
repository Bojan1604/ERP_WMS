'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zDate, zId, zIds, zMoney, zOptDate, zOptId, zOptMoney, zOptText, zReq, zText } from '@/server/zod';
import { deleteExpense, saveExpense, saveExpenseCategory, saveOccurrence, setExpensesPaid } from '@/server/services/expenses';

const zFrequency = z.enum(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']).nullable();

export const saveExpenseAction = action(
  { module: 'expenses', level: 'edit' },
  z.object({
    id: zOptId,
    date: zDate,
    categoryId: zOptId,
    description: zReq('Opis'),
    partnerId: zOptId,
    netAmount: zMoney,
    vatAmount: zMoney,
    paid: zBool,
    frequency: zFrequency,
    recurringUntil: zOptDate,
    note: zOptText,
  }),
  async ({ id, ...input }, user) =>
    transaction(async (tx) => {
      await saveExpense(tx, user, id, input);
      return { message: id ? 'Trošak spremljen.' : 'Trošak upisan.' };
    }),
);

export const deleteExpenseAction = action({ module: 'expenses', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    await deleteExpense(tx, user, id);
    return { message: 'Trošak obrisan.' };
  }),
);

export const saveOccurrenceAction = action(
  { module: 'expenses', level: 'edit' },
  z.object({ id: zId, period: zText, amount: zOptMoney, skipped: zBool }),
  async ({ id, period, amount, skipped }, user) =>
    transaction(async (tx) => {
      await saveOccurrence(tx, user, id, period, { amount, skipped });
      return { message: skipped ? 'Rata je preskočena.' : 'Rata je spremljena.' };
    }),
);

export const expensesPaidAction = action({ module: 'expenses', level: 'edit' }, z.object({ ids: zIds, paid: zBool }), async ({ ids, paid }, user) =>
  transaction(async (tx) => {
    await setExpensesPaid(tx, user, ids, paid);
    return { message: paid ? 'Označeno kao plaćeno.' : 'Označeno kao neplaćeno.' };
  }),
);

export const saveCategoryAction = action({ module: 'expenses', level: 'edit' }, z.object({ id: zOptId, name: zReq('Naziv') }), async ({ id, name }, user) =>
  transaction(async (tx) => {
    await saveExpenseCategory(tx, user, id, name);
    return { message: id ? 'Kategorija preimenovana.' : 'Kategorija dodana.' };
  }),
);
