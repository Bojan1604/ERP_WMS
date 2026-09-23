'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { zBool, zDate, zId, zMoney, zOptId, zOptText } from '@/server/zod';
import { existingSerials, receiveItems } from '@/server/services/warehouse';
import { approveReceiveRequest } from '@/server/services/receive-requests';
import { MAX_RECEIVE } from '@/domain/warehouse';

const zSerials = z.array(z.string().max(120, 'Serijski broj je predug')).max(MAX_RECEIVE, `Najviše ${MAX_RECEIVE} uređaja odjednom`);

/** Koji od upisanih serijskih brojeva već postoje u firmi (za pregled prije zaprimanja). */
export const checkSerials = action({ module: 'warehouse', level: 'edit' }, z.object({ serials: zSerials }), async ({ serials }, user) => {
  const m = await existingSerials(db, user.companyId, serials);
  // samo čitanje — bez osvježavanja prikaza
  return { data: [...m.entries()].map(([serial, rows]) => ({ serial, notes: rows.map((r) => r.dupNote ?? '') })), revalidate: [] };
});

export const receiveAction = action(
  { module: 'warehouse', level: 'edit' },
  z.object({
    modelId: zId,
    warehouseId: zId,
    supplierId: zOptId,
    cost: zMoney,
    importDate: zDate,
    supplierDocNumber: zOptText,
    note: zOptText,
    serials: zSerials,
    skipExisting: zBool,
    dupNote: zOptText,
    /** Zaprimanje po zahtjevu skladištara — zahtjev se odobrava u istoj transakciji. */
    requestId: zOptId,
  }),
  async ({ requestId, ...input }, user) =>
    transaction(async (tx) => {
      const r = await receiveItems(tx, user, input);
      const req = requestId ? await approveReceiveRequest(tx, user, requestId, { warehouseId: input.warehouseId, receiptId: r.receiptId, receiptNumber: r.number }) : null;
      if (req) {
        await audit(tx, user, {
          entity: 'approvalRequest',
          entityId: requestId,
          action: 'approve',
          summary: `Odobreno zaprimanje — primka ${r.number}, novih ${req.created}, vraćeno ${req.returned} — ${req.requestedBy}`,
        });
      }
      await audit(tx, user, {
        entity: 'receipt',
        entityId: r.receiptId,
        action: 'create',
        summary: `Primka ${r.number} — ${r.count} kom, ${r.total.toFixed(2)} €`,
      });
      const skipped = r.skipped ? ` Preskočeno postojećih: ${r.skipped}.` : '';
      // ostaje na zaprimanju: obrazac nudi naljepnice i poveznicu na primku, pa se može nastaviti sa sljedećom robom
      const back = req?.returned ? ` Vraćeno na skladište: ${req.returned} kom.` : '';
      const approved = req ? ' Zahtjev je odobren.' : '';
      return {
        message: `Zaprimljeno ${r.count} kom — primka ${r.number}.${skipped}${back}${approved}`,
        data: { receiptId: r.receiptId, number: r.number, count: r.count, returned: req?.returned ?? 0, requestApproved: !!req },
      };
    }),
);
