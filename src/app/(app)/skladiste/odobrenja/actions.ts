'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { zBool, zId, zOptText } from '@/server/zod';
import { resolveApproval } from '@/server/services/warehouse';

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
