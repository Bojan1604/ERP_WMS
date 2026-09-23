'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zId } from '@/server/zod';
import { issuePending, previewInstallment, skipPending } from '@/server/services/rentals';
import { installmentSchema } from '../schemas';

export const issueInstallmentsAction = action(
  { module: 'sales', level: 'edit' },
  z.object({ rows: z.array(installmentSchema).min(1, 'Odaberite barem jednu ratu').max(200), paid: zBool }),
  async ({ rows, paid }, user) => {
    const numbers = await transaction((tx) => issuePending(tx, user, rows, { paid }));
    const list = numbers.length > 5 ? `${numbers.slice(0, 5).join(', ')}…` : numbers.join(', ');
    return { message: `Izdano računa: ${numbers.length} (${list})${paid ? ' — označeni kao plaćeni' : ''}.` };
  },
);

export const skipInstallmentAction = action(
  { module: 'rentals', level: 'edit' },
  z.object({ rows: z.array(installmentSchema.extend({ itemIds: z.array(zId).min(1) })).min(1).max(200) }),
  async ({ rows }, user) => {
    await transaction(async (tx) => {
      for (const r of rows) await skipPending(tx, user, r.contractId, r.period, r.itemIds);
    });
    return { message: `Označeno kao izdano izvan programa: ${rows.length} rata.` };
  },
);

export const previewInstallmentAction = action({ module: 'sales', level: 'edit' }, installmentSchema, async ({ contractId, period }, user) => {
  const id = await transaction((tx) => previewInstallment(tx, user, contractId, period));
  return { redirect: `/prodaja/racuni/${id}`, message: 'Nacrt računa pripremljen.' };
});
