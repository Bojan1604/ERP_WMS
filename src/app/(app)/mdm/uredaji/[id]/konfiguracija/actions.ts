'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { getMdmScope } from '@/server/mdm/scope';
import { queueCommands } from '@/server/mdm/commands';
import { clearDeviceOverrides, saveDeviceOverrides, setDeviceProfile, zConfig } from '@/server/mdm/profiles';

const zDevice = z.object({ deviceId: z.string().min(1) });
const zSetProfile = zDevice.extend({ profileId: z.preprocess((v) => (v === '' ? null : v), z.string().nullable()) });

export const setDeviceProfileAction = action(
  { module: 'mdm', level: 'edit' },
  zSetProfile,
  async ({ deviceId, profileId }, user) => {
    const scope = await getMdmScope(user);
    await transaction((tx) => setDeviceProfile(tx, scope, user, deviceId, profileId));
    return { message: profileId ? 'Uređaj ima vlastitu konfiguraciju.' : 'Uređaj koristi konfiguraciju lokacije.' };
  },
);

export const saveDeviceOverridesAction = action({ module: 'mdm', level: 'edit' }, zConfig.merge(zDevice), async ({ deviceId, ...input }, user) => {
  const scope = await getMdmScope(user);
  const o = await transaction((tx) => saveDeviceOverrides(tx, scope, user, deviceId, input));
  const n = Object.keys(o.settings ?? {}).length + (o.apps?.length ?? 0);
  return { message: n ? `Izmjene uređaja spremljene (${n}).` : 'Uređaj koristi konfiguraciju bez izmjena.' };
});

export const clearDeviceOverridesAction = action({ module: 'mdm', level: 'edit' }, zDevice, async ({ deviceId }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => clearDeviceOverrides(tx, scope, user, deviceId));
  return { message: 'Izmjene uređaja uklonjene.' };
});

export const applyConfigNowAction = action({ module: 'mdm', level: 'edit' }, zDevice, async ({ deviceId }, user) => {
  const scope = await getMdmScope(user);
  const r = await transaction((tx) => queueCommands(tx, scope, [deviceId], 'APPLY_CONFIG', {}));
  return { message: r.queued ? 'Naredba poslana — uređaj primjenjuje konfiguraciju pri sljedećem javljanju.' : 'Naredba već čeka uređaj.' };
});
