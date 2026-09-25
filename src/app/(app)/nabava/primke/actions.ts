'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zId, zOptText } from '@/server/zod';
import { cancelReceipt } from '@/server/services/purchasing';
import { bookReceiptExpense } from '@/server/services/supplier-invoices';
import { canSeeCost } from '@/domain/permissions';
import { DomainError } from '@/server/errors';
import { countLabel, plural } from '@/domain/plural';

export const cancelReceiptAction = action({ module: 'purchasing', level: 'edit' }, z.object({ id: zId, reason: zOptText }), async ({ id, reason }, user) =>
  transaction(async (tx) => {
    const r = await cancelReceipt(tx, user, id, reason);
    return { message: `Primka je stornirana — ${plural(r.count, 'obrisan', 'obrisana', 'obrisano')} ${countLabel(r.count, 'uređaj', 'uređaja', 'uređaja')} i knjiženi trošak.` };
  }),
);

/** Naknadno knjiženje troška primke (zaprimljeno bez knjiženja ili trošak obrisan stornom računa) — nikad dvaput. */
export const bookReceiptExpenseAction = action({ module: 'purchasing', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    if (!canSeeCost(user.perms)) throw new DomainError('Nemate pravo na nabavne cijene.');
    const r = await bookReceiptExpense(tx, user, id);
    return { message: `Knjižen trošak nabave ${r.total.toFixed(2).replace('.', ',')} €.` };
  }),
);
