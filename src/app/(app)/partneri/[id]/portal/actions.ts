'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zId, zOptText } from '@/server/zod';
import { createPortalUser, deletePortalUser, resetPortalPassword, setPortalUserActive, updatePortalUser } from '@/server/portal/users';

const zEmail = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.string().min(1, 'Upišite e-adresu za prijavu.').max(200, 'E-adresa je preduga.').email('E-adresa nije ispravna.'),
);
const zName = zOptText.refine((v) => !v || v.length <= 120, 'Ime je predugo.');
const access = { module: 'partners', level: 'edit' } as const;
const revalidate = (partnerId: string) => [`/partneri/${partnerId}/portal`];

/** Novi pristup portalu — vraća generiranu lozinku (prikazuje se samo jednom). */
export const createPortalUserAction = action(access, z.object({ partnerId: zId, name: zName, email: zEmail }), async (input, user) => {
  const out = await transaction((tx) => createPortalUser(tx, user, input));
  return { data: { email: out.email, password: out.password }, message: 'Pristup otvoren — pošaljite klijentu poveznicu i podatke za prijavu.', revalidate: revalidate(input.partnerId) };
});

export const updatePortalUserAction = action(access, z.object({ id: zId, partnerId: zId, name: zName, email: zEmail }), async (input, user) => {
  await transaction((tx) => updatePortalUser(tx, user, input.id, input));
  return { message: 'Spremljeno.', revalidate: revalidate(input.partnerId) };
});

export const setPortalUserActiveAction = action(access, z.object({ id: zId, partnerId: zId, active: zBool }), async (input, user) => {
  await transaction((tx) => setPortalUserActive(tx, user, input.id, input.active));
  return { message: input.active ? 'Pristup uključen.' : 'Pristup isključen — klijent je odjavljen.', revalidate: revalidate(input.partnerId) };
});

/** Nova lozinka — stare sesije se odjavljuju, lozinka se prikazuje samo jednom. */
export const resetPortalPasswordAction = action(access, z.object({ id: zId, partnerId: zId }), async (input, user) => {
  const out = await transaction((tx) => resetPortalPassword(tx, user, input.id));
  return { data: out, message: 'Nova lozinka je postavljena.', revalidate: revalidate(input.partnerId) };
});

export const deletePortalUserAction = action(access, z.object({ id: zId, partnerId: zId }), async (input, user) => {
  await transaction((tx) => deletePortalUser(tx, user, input.id));
  return { message: 'Pristup obrisan.', revalidate: revalidate(input.partnerId) };
});
