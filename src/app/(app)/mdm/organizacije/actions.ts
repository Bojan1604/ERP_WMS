'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { getMdmScope } from '@/server/mdm/scope';
import { deleteOrg, deleteSite, saveOrg, saveSite } from '@/server/mdm/orgs';
import { resetMdmPassword, saveMdmUser, setMdmUserActive } from '@/server/mdm/users';
import { zBool, zId, zOptId, zOptText, zReq } from '@/server/zod';

const orgSchema = z.object({
  id: zOptId,
  type: z.enum(['DISTRIBUTOR', 'CUSTOMER']).default('CUSTOMER'),
  parentId: zOptId,
  name: zReq('Naziv'),
  oib: zOptText,
  email: zOptText,
  phone: zOptText,
  address: zOptText,
  city: zOptText,
  note: zOptText,
  active: zBool,
  partnerId: zOptId,
});

export const saveOrgAction = action({ module: 'mdm', level: 'edit' }, orgSchema, async ({ id, ...input }, user) => {
  const scope = await getMdmScope(user);
  const orgId = await transaction((tx) => saveOrg(tx, scope, id, input));
  return { message: id ? 'Organizacija spremljena.' : 'Organizacija otvorena.', redirect: id ? undefined : `/mdm/organizacije/${orgId}` };
});

export const deleteOrgAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => deleteOrg(tx, scope, id));
  return { message: 'Organizacija obrisana.', redirect: '/mdm/organizacije' };
});

const siteSchema = z.object({
  id: zOptId,
  orgId: zId,
  name: zReq('Naziv'),
  address: zOptText,
  timezone: z.string().trim().default('Europe/Zagreb'),
  profileId: zOptId,
  note: zOptText,
});

export const saveSiteAction = action({ module: 'mdm', level: 'edit' }, siteSchema, async ({ id, ...input }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => saveSite(tx, scope, id, input));
  return { message: id ? 'Lokacija spremljena.' : 'Lokacija dodana.' };
});

export const deleteSiteAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => deleteSite(tx, scope, id));
  return { message: 'Lokacija obrisana.' };
});

const userSchema = z.object({
  id: zOptId,
  orgId: zId,
  name: zReq('Ime'),
  email: zReq('E-adresa'),
  password: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().nullable()),
  active: zBool,
  level: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.enum(['view', 'ops', 'edit']).nullable()),
});

export const saveMdmUserAction = action({ module: 'mdm', level: 'edit' }, userSchema, async ({ id, ...input }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => saveMdmUser(tx, scope, id, input));
  return { message: id ? 'Korisnik spremljen.' : 'Korisnik dodan.' };
});

export const setMdmUserActiveAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: zId, active: zBool }), async ({ id, active }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => setMdmUserActive(tx, scope, id, active));
  return { message: active ? 'Korisnik aktiviran.' : 'Korisnik deaktiviran i odjavljen.' };
});

export const resetMdmPasswordAction = action({ module: 'mdm', level: 'edit' }, z.object({ id: zId, password: z.string() }), async ({ id, password }, user) => {
  const scope = await getMdmScope(user);
  await transaction((tx) => resetMdmPassword(tx, scope, id, password));
  return { message: 'Lozinka promijenjena; korisnik je odjavljen sa svih uređaja.' };
});
