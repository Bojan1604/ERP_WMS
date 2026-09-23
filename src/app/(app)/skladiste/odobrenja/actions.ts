'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { zBool, zId, zOptText } from '@/server/zod';
import { resolveApproval } from '@/server/services/warehouse';
import { can } from '@/domain/permissions';
import { ackRequest, approveReceiveRequest } from '@/server/services/receive-requests';

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

/** Podnositelj je vidio odbijeni zahtjev. */
export const ackRequestAction = action({ module: 'warehouse', level: 'view' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    await ackRequest(tx, user, id, { canManage: can(user.perms, 'warehouse', 'edit') });
    return { revalidate: ['/skladiste'] };
  }),
);
