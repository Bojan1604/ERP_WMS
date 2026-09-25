'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { plain } from '@/server/plain';
import { can, canSeeCost } from '@/domain/permissions';
import { assert } from '@/server/errors';
import { zBool, zId, zOptId, zOptText } from '@/server/zod';
import { closeStocktake, createStocktake, deleteStocktake, removeScan, scanStocktake } from '@/server/services/stocktake';
import { stocktakeLiveCounts, stocktakeScanView } from '@/server/queries/stocktake';

export const createStocktakeAction = action(
  { module: 'warehouse', level: 'ops' },
  z.object({ warehouseId: zOptId, note: zOptText }),
  async (input, user) =>
    transaction(async (tx) => {
      const st = await createStocktake(tx, user, input);
      await audit(tx, user, { entity: 'stocktake', entityId: st.id, action: 'create', summary: `Inventura ${st.number} započeta` });
      return { message: `Inventura ${st.number} je otvorena — počnite skenirati.`, redirect: `/skladiste/inventura/${st.id}` };
    }),
);

/** Jedan sken. Bez osvježavanja cijele aplikacije — klijent sam osvježava popise s odgodom. */
export const scanStocktakeAction = action(
  { module: 'warehouse', level: 'ops' },
  z.object({ id: zId, code: z.string().trim().min(1, 'Prazan kod').max(500), itemId: zOptId }),
  async ({ id, code, itemId }, user) => {
    const r = await transaction((tx) => scanStocktake(tx, user, { stocktakeId: id, code, itemId }));
    // nabavna cijena uređaja samo uz pravo `costs`
    return { data: plain(stocktakeScanView(r, canSeeCost(user.perms))), revalidate: [] };
  },
);

export const removeScanAction = action({ module: 'warehouse', level: 'ops' }, z.object({ id: zId, scanId: zId }), async ({ id, scanId }, user) => {
  const r = await transaction((tx) => removeScan(tx, user, { stocktakeId: id, scanId }));
  return { data: r, revalidate: [] };
});

/** Brojači za živi prikaz (više ljudi skenira istu inventuru). */
export const stocktakeCountsAction = action({ module: 'warehouse', level: 'view' }, z.object({ id: zId }), async ({ id }, user) => {
  const st = await db.stocktake.findFirst({ where: { id, companyId: user.companyId }, select: { id: true, warehouseId: true, status: true } });
  assert(st, 'Inventura ne postoji.');
  const counts = await stocktakeLiveCounts(db, user.companyId, st);
  return { data: { ...counts, status: st.status }, revalidate: [] };
});

export const closeStocktakeAction = action(
  { module: 'warehouse', level: 'ops' },
  z.object({
    id: zId,
    moveWrongWarehouse: zBool,
    missingAction: z.enum(['none', 'status', 'writeOff']).default('none'),
    missingStatusId: zOptId,
    bookExpense: zBool,
  }),
  async (input, user) => {
    // radnje nad uređajima (premještaj, status, otpis) traže razinu „uređivanje"
    if (input.moveWrongWarehouse || input.missingAction !== 'none') assert(can(user.perms, 'warehouse', 'edit'), 'Radnje nad uređajima pri zatvaranju traže razinu „Uređivanje".');
    if (input.missingAction === 'status') assert(input.missingStatusId, 'Odaberite status za uređaje koji nedostaju.');
    return transaction(async (tx) => {
      const r = await closeStocktake(tx, user, {
        id: input.id,
        moveWrongWarehouse: input.moveWrongWarehouse,
        missing:
          input.missingAction === 'status'
            ? { kind: 'status', statusId: input.missingStatusId! }
            : input.missingAction === 'writeOff'
              ? { kind: 'writeOff', bookExpense: input.bookExpense }
              : { kind: 'none' },
      });
      const s = r.summary;
      const parts = [`pronađeno ${s.found}/${s.expected}`, `nedostaje ${s.missing}`, `višak ${s.extra}`];
      if (s.actions.moved) parts.push(`premješteno ${s.actions.moved} (${s.actions.transfers.join(', ')})`);
      if (s.actions.missingChanged) parts.push(`${s.actions.missingAction}: ${s.actions.missingChanged}`);
      await audit(tx, user, { entity: 'stocktake', entityId: input.id, action: 'close', summary: `Inventura ${r.number} zatvorena — ${parts.join(', ')}` });
      return { message: `Inventura ${r.number} je zatvorena — ${parts.join(', ')}.` };
    });
  },
);

export const deleteStocktakeAction = action({ module: 'warehouse', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    const r = await deleteStocktake(tx, user, id);
    await audit(tx, user, { entity: 'stocktake', entityId: id, action: 'delete', summary: `Inventura ${r.number} obrisana` });
    return { message: `Inventura ${r.number} je obrisana.`, redirect: '/skladiste/inventura' };
  }),
);
