'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zOptText } from '@/server/zod';
import { getMdmScope } from '@/server/mdm/scope';
import { removeFile } from '@/server/mdm/storage';
import { deleteApp, deleteVersion, updateApp, updateVersionNotes } from '@/server/mdm/apps';

const zId = z.object({ id: z.string().min(1) });

export const updateAppAction = action(
  { module: 'mdm', level: 'edit' },
  z.object({ id: z.string().min(1), name: z.string().trim().min(1, 'Naziv je obavezan').max(120), description: zOptText, installArgs: zOptText }),
  async (input, user) => {
    const scope = await getMdmScope(user);
    await transaction((tx) => updateApp(tx, scope, user, input));
    return { message: 'Spremljeno.' };
  },
);

export const updateVersionNotesAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: z.string().min(1), notes: zOptText }), async ({ id, notes }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => updateVersionNotes(tx, scope, user, id, notes));
  return { message: 'Bilješka spremljena.' };
});

export const deleteVersionAction = action({ module: 'mdm', level: 'edit' }, zId, async ({ id }, user) => {
  const scope = await getMdmScope(user);
  const key = await transaction((tx) => deleteVersion(tx, scope, user, id));
  await removeFile(key).catch(() => {});
  return { message: 'Verzija obrisana.' };
});

export const deleteAppAction = action({ module: 'mdm', level: 'edit' }, zId, async ({ id }, user) => {
  const scope = await getMdmScope(user);
  const keys = await transaction((tx) => deleteApp(tx, scope, user, id));
  await Promise.all(keys.map((k) => removeFile(k).catch(() => {})));
  return { message: 'Aplikacija obrisana.', redirect: '/mdm/aplikacije' };
});
