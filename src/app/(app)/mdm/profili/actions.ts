'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zIds } from '@/server/zod';
import { getMdmScope } from '@/server/mdm/scope';
import { assignSites, deleteProfile, duplicateProfile, saveProfile, zProfile, zSettings } from '@/server/mdm/profiles';

const affectedMsg = (n: number) => (n ? `Primijenit će se na ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'uređaj' : 'uređaja'}.` : '');

export const saveProfileAction = action({ module: 'mdm', level: 'edit' }, zProfile, async (input, user) => {
  const scope = await getMdmScope(user);
  const r = await transaction((tx) => saveProfile(tx, scope, user, input));
  return {
    message: input.id ? `Konfiguracija spremljena (v${r.version}). ${affectedMsg(r.affected)}`.trim() : 'Konfiguracija stvorena.',
    redirect: input.id ? undefined : `/mdm/profili/${r.id}`,
    data: r,
  };
});

export const assignSitesAction = action({ module: 'mdm', level: 'edit' }, z.object({ profileId: z.string().min(1), siteIds: zIds }), async (input, user) => {
  const scope = await getMdmScope(user);
  const r = await transaction((tx) => assignSites(tx, scope, user, input.profileId, input.siteIds));
  return { message: `Lokacije spremljene (+${r.added} / −${r.removed}). ${affectedMsg(r.affected)}`.trim(), data: r };
});

export const duplicateProfileAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: z.string().min(1) }), async ({ id }, user) => {
  const scope = await getMdmScope(user);
  const r = await transaction((tx) => duplicateProfile(tx, scope, user, id));
  return { message: 'Kopija stvorena.', redirect: `/mdm/profili/${r.id}` };
});

export const deleteProfileAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: z.string().min(1) }), async ({ id }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => deleteProfile(tx, scope, user, id));
  return { message: 'Konfiguracija obrisana.', redirect: '/mdm/profili' };
});

export const createProfileAction = action(
  { module: 'mdm', level: 'edit' },
  zProfile.pick({ name: true, platform: true, orgId: true, note: true }),
  async (input, user) => {
    const scope = await getMdmScope(user);
    const r = await transaction((tx) => saveProfile(tx, scope, user, { ...input, id: null, settings: zSettings.parse({}), apps: [] }));
    return { message: 'Konfiguracija stvorena.', redirect: `/mdm/profili/${r.id}` };
  },
);
