'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zId, zOptId, zOptInt, zOptMoney, zOptText, zReq } from '@/server/zod';
import { deletePartner, deletePriceAgreement, savePartner, savePriceAgreement } from '@/server/services/partners';

const partnerSchema = z.object({
  id: zOptId,
  name: zReq('Naziv'),
  oib: zOptText,
  vatId: zOptText,
  address: zOptText,
  zip: zOptText,
  city: zOptText,
  country: zReq('Država'),
  email: zOptText.refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Neispravna e-adresa'),
  phone: zOptText,
  iban: zOptText,
  contactPerson: zOptText,
  isCustomer: zBool,
  isSupplier: zBool,
  excluded: zBool,
  paymentTermDays: zOptInt.refine((v) => v === null || (v >= 0 && v <= 365), 'Rok plaćanja mora biti 0–365 dana'),
  note: zOptText,
});

export const savePartnerAction = action({ module: 'partners', level: 'edit' }, partnerSchema, async ({ id, ...input }, user) => {
  const pid = await transaction((tx) => savePartner(tx, user, id, input));
  return { message: id ? 'Partner spremljen.' : 'Partner dodan.', redirect: id ? undefined : `/partneri/${pid}`, data: pid };
});

export const deletePartnerAction = action({ module: 'partners', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  await transaction((tx) => deletePartner(tx, user, id));
  return { message: 'Partner obrisan.', redirect: '/partneri' };
});

export const savePriceAction = action(
  { module: 'partners', level: 'edit' },
  z.object({ id: zOptId, partnerId: zId, modelId: zReq('Model'), salePrice: zOptMoney, rentPrice: zOptMoney }),
  async (input, user) => {
    await transaction((tx) => savePriceAgreement(tx, user, input));
    return { message: 'Dogovorena cijena spremljena.' };
  },
);

export const deletePriceAction = action({ module: 'partners', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  await transaction((tx) => deletePriceAgreement(tx, user, id));
  return { message: 'Dogovorena cijena obrisana.' };
});
