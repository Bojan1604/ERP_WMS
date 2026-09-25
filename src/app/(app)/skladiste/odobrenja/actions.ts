'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { zBool, zDate, zId, zIds, zMoney, zOptId, zOptText } from '@/server/zod';
import { resolveApproval } from '@/server/services/warehouse';
import { can, canSeeCost } from '@/domain/permissions';
import { MAX_RECEIVE } from '@/domain/warehouse';
import { ackRequest, approveReceiveRequest, approveReceiveRows } from '@/server/services/receive-requests';

export const resolveApprovalAction = action(
  { module: 'warehouse', level: 'edit' },
  z.object({ id: zId, approve: zBool, note: zOptText }),
  async ({ id, approve, note }, user) =>
    transaction(async (tx) => {
      const r = await resolveApproval(tx, user, id, approve, note);
      await audit(tx, user, {
        entity: 'approvalRequest',
        entityId: id,
        action: approve ? 'approve' : 'reject',
        summary: approve ? `Odobrena promjena statusa (${r.applied} kom) — ${r.requestedBy}` : `Odbijen zahtjev — ${r.requestedBy}: ${note}`,
      });
      return { message: approve ? `Zahtjev odobren — status promijenjen (${r.applied} kom).` : 'Zahtjev odbijen.' };
    }),
);

/** Zahtjev za zaprimanje bez novih serijskih — poznati uređaji se vraćaju na skladište. */
export const approveReceiveAction = action(
  { module: 'warehouse', level: 'edit' },
  z.object({ id: zId, warehouseId: zId }),
  async ({ id, warehouseId }, user) =>
    transaction(async (tx) => {
      const r = await approveReceiveRequest(tx, user, id, { warehouseId });
      await audit(tx, user, {
        entity: 'approvalRequest',
        entityId: id,
        action: 'approve',
        summary: `Odobreno zaprimanje — vraćeno na skladište „${r.warehouse}" ${r.returned} kom — ${r.requestedBy}`,
      });
      return { message: `Zahtjev odobren — na skladište „${r.warehouse}" vraćeno ${r.returned} kom.` };
    }),
);

/**
 * Odobravanje zahtjeva za zaprimanje po retku: model po kodu, ispravak
 * serijskog broja, preskakanje reda; novi uređaji jednom primkom.
 */
export const approveReceiveRowsAction = action(
  { module: 'warehouse', level: 'edit' },
  z.object({
    id: zId,
    warehouseId: zId,
    supplierId: zOptId,
    cost: zMoney,
    importDate: zDate,
    supplierDocNumber: zOptText,
    note: zOptText,
    bookExpense: zBool,
    rows: z.array(z.object({ code: z.string().min(1).max(120), serial: z.string().max(200), modelId: zOptId, skip: zBool })).max(MAX_RECEIVE, `Najviše ${MAX_RECEIVE} redaka.`),
    skipReturning: zIds,
  }),
  async ({ id, ...input }, user) =>
    transaction(async (tx) => {
      // bez prava na nabavne cijene nabavna se ne upisuje (0) — knjiži je kasnije netko s pravom
      const r = await approveReceiveRows(tx, user, id, canSeeCost(user.perms) ? input : { ...input, cost: 0 });
      await audit(tx, user, {
        entity: 'approvalRequest',
        entityId: id,
        action: 'approve',
        summary: `Odobreno zaprimanje po retku — ${r.receiptNumber ? `primka ${r.receiptNumber}, novih ${r.created}, ` : ''}vraćeno ${r.returned}, preskočeno ${r.skipped} — ${r.requestedBy}`,
      });
      return {
        message: `Zahtjev odobren${r.receiptNumber ? ` — primka ${r.receiptNumber} (${r.created} kom)` : ''}${r.returned ? `, vraćeno na skladište ${r.returned} kom` : ''}${r.skipped ? `, preskočeno ${r.skipped}` : ''}.`,
        redirect: '/skladiste/odobrenja',
      };
    }),
);

/** Podnositelj je vidio odbijeni zahtjev. */
export const ackRequestAction = action({ module: 'warehouse', level: 'view' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    await ackRequest(tx, user, id, { canManage: can(user.perms, 'warehouse', 'edit') });
    return { revalidate: ['/skladiste'] };
  }),
);
