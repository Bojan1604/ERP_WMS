'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { getMdmScope } from '@/server/mdm/scope';
import { installOnDevice, uninstallOnDevice } from '@/server/mdm/apps';

const zInstall = z.object({ deviceId: z.string().min(1), appId: z.string().min(1), versionId: z.preprocess((v) => (v === '' ? null : v ?? null), z.string().nullable()) });
const zUninstall = z.object({ deviceId: z.string().min(1), packageName: z.string().trim().min(1).max(200), name: z.string().max(200).nullable().optional() });

const done = (r: { queued: number; label: string }) => ({ message: r.queued ? `${r.label}: naredba poslana uređaju.` : `${r.label}: ista naredba već čeka uređaj.` });

export const installAppAction = action(
  { module: 'mdm', level: 'edit' },
  zInstall,
  async ({ deviceId, appId, versionId }, user) => {
    const scope = await getMdmScope(user);
    return done(await transaction((tx) => installOnDevice(tx, scope, deviceId, appId, versionId)));
  },
);

export const uninstallAppAction = action(
  { module: 'mdm', level: 'edit' },
  zUninstall,
  async ({ deviceId, packageName, name }, user) => {
    const scope = await getMdmScope(user);
    return done(await transaction((tx) => uninstallOnDevice(tx, scope, deviceId, packageName, name ?? null)));
  },
);
