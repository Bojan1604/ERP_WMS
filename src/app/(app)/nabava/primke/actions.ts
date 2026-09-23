'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zId, zOptText } from '@/server/zod';
import { cancelReceipt } from '@/server/services/purchasing';

export const cancelReceiptAction = action({ module: 'purchasing', level: 'edit' }, z.object({ id: zId, reason: zOptText }), async ({ id, reason }, user) =>
  transaction(async (tx) => {
    const r = await cancelReceipt(tx, user, id, reason);
    return { message: `Primka je stornirana — obrisano ${r.count} uređaja i knjiženi trošak.` };
  }),
);
