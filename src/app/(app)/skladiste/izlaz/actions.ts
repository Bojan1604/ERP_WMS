'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { addOutToContract } from '@/server/services/warehouse';
import { audit } from '@/server/audit';
import { zId, zIds, zOptId, zOptText } from '@/server/zod';
import { cancelOut, receiveReturned } from '@/server/services/warehouse';
import { escapeLike } from '@/lib/like';
import { countLabel, plural } from '@/domain/plural';

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

/** Aktivni ugovori za „Na postojeći ugovor" (ugovori kupca izlaza ili pretraga po broju / klijentu). */
export const activeContractsAction = action(
  { module: 'rentals', level: 'edit' },
  z.object({ q: zOptText, partnerId: zOptId }),
  async ({ q, partnerId }, user) => {
    const rows = await db.contract.findMany({
      where: {
        companyId: user.companyId,
        status: { in: ['ACTIVE', 'PAUSED'] },
        ...(partnerId && !q ? { partnerId } : {}),
        ...(q ? { OR: [{ number: { contains: escapeLike(q), mode: 'insensitive' } }, { partner: { name: { contains: escapeLike(q), mode: 'insensitive' } } }] } : {}),
      },
      orderBy: [{ startDate: 'desc' }],
      take: 40,
      select: { id: true, number: true, partner: { select: { name: true } }, _count: { select: { items: true } } },
    });
    return { data: rows.map((c) => ({ value: c.id, label: `${c.number} · ${c.partner.name}`, hint: countLabel(c._count.items, 'uređaj', 'uređaja', 'uređaja') })), revalidate: [] };
  },
);

/**
 * Izašli uređaji na postojeći aktivni ugovor (E11): predložena mjesečna cijena
 * (cjenik kupca → uređaj → model → % nabavne), status „U najmu" i klijent s
 * ugovora — preko servisa najma (`addDevices` → `attachItems`).
 */
export const addOutToContractAction = action(
  { module: 'rentals', level: 'edit' },
  z.object({ contractId: zId, itemIds: zIds }),
  async ({ contractId, itemIds }, user) =>
    transaction(async (tx) => {
      const r = await addOutToContract(tx, user, contractId, itemIds);
      return { message: `${countLabel(r.count, 'uređaj', 'uređaja', 'uređaja')} ${plural(r.count, 'dodan', 'dodana', 'dodano')} na ugovor ${r.number}. Cijenu i plan naplate po potrebi dotjerajte na ugovoru.`, data: { contractId } };
    }),
);
