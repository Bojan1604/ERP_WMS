'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { zId, zIds } from '@/server/zod';
import { cancelOut, receiveReturned } from '@/server/services/warehouse';

export const cancelOutAction = action({ module: 'warehouse', level: 'ops' }, z.object({ itemIds: zIds }), async ({ itemIds }, user) =>
  transaction(async (tx) => {
    const r = await cancelOut(tx, user, itemIds);
    await audit(tx, user, { entity: 'item', action: 'cancelOut', summary: `Vraćeno na skladište — poništen izlaz (${r.count} kom)`, diff: { itemIds } });
    return { message: `Vraćeno na skladište (${r.count} kom).` };
  }),
);

export const receiveReturnedAction = action(
  { module: 'warehouse', level: 'ops' },
  z.object({ itemIds: zIds, warehouseId: zId }),
  async ({ itemIds, warehouseId }, user) =>
    transaction(async (tx) => {
      const r = await receiveReturned(tx, user, itemIds, warehouseId);
      await audit(tx, user, { entity: 'item', action: 'returned', summary: `Zaprimljen povrat u „${r.warehouse}" (${r.count} kom)`, diff: { itemIds } });
      return { message: `Zaprimljeno na skladište „${r.warehouse}" (${r.count} kom).` };
    }),
);
