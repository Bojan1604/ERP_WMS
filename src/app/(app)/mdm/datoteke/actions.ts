'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zIds } from '@/server/zod';
import { getMdmScope } from '@/server/mdm/scope';
import { removeFile } from '@/server/mdm/storage';
import { deleteLibraryFile, pushFile } from '@/server/mdm/files';

const zPush = z.object({
  fileId: z.string().min(1),
  deviceIds: zIds,
  siteId: z.preprocess((v) => (v === '' ? null : v ?? null), z.string().nullable()),
  targetPath: z.preprocess((v) => (typeof v === 'string' ? v.trim() || null : v ?? null), z.string().max(260).nullable()),
});

export const deleteFileAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: z.string().min(1) }), async ({ id }, user) => {
  const scope = await getMdmScope(user);
  const key = await transaction((tx) => deleteLibraryFile(tx, scope, user, id));
  await removeFile(key).catch(() => {});
  return { message: 'Obrisano.' };
});

export const pushFileAction = action(
  { module: 'mdm', level: 'edit' },
  zPush,
  async (input, user) => {
    const scope = await getMdmScope(user);
    const r = await transaction((tx) => pushFile(tx, scope, user, input));
    return { message: `Datoteka poslana na ${r.queued} uređaja${r.skipped ? ` (preskočeno ${r.skipped})` : ''}.`, data: r };
  },
);
