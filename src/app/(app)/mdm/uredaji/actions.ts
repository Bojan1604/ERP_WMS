'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { DomainError } from '@/server/errors';
import { getMdmScope } from '@/server/mdm/scope';
import { queueCommands } from '@/server/mdm/commands';
import { removeFile } from '@/server/mdm/storage';
import { actorOf, assignProfile, cancelCommand, linkItem, moveDevices, removeDevice, updateDevice } from '@/server/mdm/devices';
import { zId, zIds, zOptId } from '@/server/zod';
import type { Prisma } from '@prisma/client';

/** Naredbe koje portal šalje ručno (ostale šalju profili/aplikacije). */
const UI_COMMANDS = ['REBOOT', 'FORGET', 'SCREENSHOT', 'UPLOAD_LOGS', 'LOCK', 'WIPE', 'MESSAGE', 'APPLY_CONFIG'] as const;

export const sendCommandAction = action(
  { module: 'mdm', level: 'ops' },
  z.object({
    ids: zIds,
    type: z.enum(UI_COMMANDS),
    text: z.string().trim().max(500).optional(),
  }),
  async ({ ids, type, text }, user) => {
    const scope = await getMdmScope(user);
    let payload: Prisma.InputJsonValue = {};
    if (type === 'MESSAGE') {
      if (!text) throw new DomainError('Upišite poruku za zaslon uređaja.');
      payload = { text };
    }
    const r = await transaction(async (tx) => {
      const res = await queueCommands(tx, scope, ids, type, payload);
      if (res.queued) {
        await audit(tx, actorOf(scope), {
          entity: 'mdmDevice',
          entityId: ids.length === 1 ? ids[0] : null,
          action: 'command',
          summary: `Naredba „${res.label}" za ${res.queued} uređaja`,
          diff: { type, ids },
        });
      }
      return res;
    });
    const skipped = r.skipped ? ` (${r.skipped} preskočeno — već čeka ili nije upisan)` : '';
    // naredba ne mijenja prikaz ostalih stranica; klijent sam osvježava trenutnu (useAction → router.refresh)
    return { message: r.queued ? `${r.label}: poslano ${r.queued} uređaja${skipped}.` : `${r.label}: naredba već čeka uređaj.`, data: { queued: r.queued }, revalidate: [] };
  },
);

export const moveDevicesAction = action({ module: 'mdm', level: 'edit' }, z.object({ ids: zIds, orgId: zId, siteId: zOptId }), async (input, user) => {
  const scope = await getMdmScope(user);
  const n = await transaction((tx) => moveDevices(tx, scope, input.ids, input.orgId, input.siteId));
  return { message: `Premješteno uređaja: ${n}.` };
});

export const assignProfileAction = action({ module: 'mdm', level: 'edit' }, z.object({ ids: zIds, profileId: zOptId }), async (input, user) => {
  const scope = await getMdmScope(user);
  const n = await transaction((tx) => assignProfile(tx, scope, input.ids, input.profileId));
  return { message: `Konfiguracija dodijeljena (${n} uređaja).` };
});

const optText = (max: number) => z.preprocess((v) => (v === undefined ? undefined : typeof v === 'string' ? v : null), z.string().max(max).nullable().optional());

export const updateDeviceAction = action(
  { module: 'mdm', level: 'ops' },
  z.object({ id: zId, name: z.string().max(100).optional(), notes: optText(5000), maintenancePin: optText(8) }),
  async ({ id, ...patch }, user) => {
    const scope = await getMdmScope(user);
    await transaction((tx) => updateDevice(tx, scope, id, patch));
    return { message: 'Spremljeno.' };
  },
);

export const linkItemAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: zId, itemId: zOptId }), async ({ id, itemId }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => linkItem(tx, scope, id, itemId));
  return { message: itemId ? 'Uređaj povezan sa skladištem.' : 'Veza sa skladištem uklonjena.' };
});

export const cancelCommandAction = action({ module: 'mdm', level: 'ops' }, z.object({ id: zId }), async ({ id }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => cancelCommand(tx, scope, id));
  return { message: 'Naredba otkazana.' };
});

export const removeDeviceAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  const scope = await getMdmScope(user);
  const r = await transaction((tx) => removeDevice(tx, scope, id));
  await Promise.all(r.storageKeys.map((k) => removeFile(k).catch(() => {})));
  return { message: 'Uređaj uklonjen.', redirect: '/mdm/uredaji' };
});
