'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zDate, zId, zMoney, zOptDate, zOptId, zOptText, zReq, zText } from '@/server/zod';
import { deviceWarrantyEnd, itemForService, searchItems } from '@/server/queries/service';
import { today } from '@/domain/dates';
import { changeServiceStatus, createServiceOrder, deleteServiceOrder, replaceDevice, returnDevice, updateServiceOrder } from '@/server/services/service';
import { modelLabel } from '@/server/queries/lookups';
import { STATUS_KIND_LABEL } from '@/server/services/items';

/** Pretraga uređaja za odabir (nalog ili zamjenski uređaj) — bez osvježavanja stranice. */
export const searchDevicesAction = action(
  { module: 'service', level: 'view' },
  z.object({ q: zText, stockOnly: zBool, excludeId: zOptId }),
  async ({ q, stockOnly, excludeId }, user) => {
    const rows = await searchItems(user.companyId, q, { stockOnly, excludeId });
    return {
      revalidate: [],
      data: rows.map((r) => ({
        value: r.id,
        label: `${r.serial} — ${modelLabel(r.model)}`,
        hint: r.partner?.name ?? r.warehouse?.name ?? STATUS_KIND_LABEL[r.state],
      })),
    };
  },
);

export const createServiceAction = action(
  { module: 'service', level: 'edit' },
  z.object({
    itemId: zId,
    issue: zReq('Opis kvara'),
    reportedAt: zDate,
    status: z.enum(['REPORTED', 'RECEIVED']),
    underWarranty: zBool,
    note: zOptText,
    setServiceStatus: zBool,
  }),
  async (input, user) =>
    transaction(async (tx) => {
      const o = await createServiceOrder(tx, user, input);
      return { message: `Otvoren servisni nalog ${o.number}.`, redirect: `/servis/${o.id}` };
    }),
);

export const updateServiceAction = action(
  { module: 'service', level: 'edit' },
  z.object({
    id: zId,
    issue: zReq('Opis kvara'),
    diagnosis: zOptText,
    action: zOptText,
    solution: zOptText,
    cost: zMoney,
    underWarranty: zBool,
    publicNote: zOptText,
    note: zOptText,
    reportedAt: zDate,
    receivedAt: zOptDate,
  }),
  async ({ id, ...input }, user) =>
    transaction(async (tx) => {
      await updateServiceOrder(tx, user, id, input);
      return { message: 'Nalog spremljen.' };
    }),
);

export const serviceStatusAction = action(
  { module: 'service', level: 'edit' },
  z.object({
    id: zId,
    status: z.enum(['REPORTED', 'RECEIVED', 'DIAGNOSIS', 'AT_SUPPLIER', 'REPAIRED', 'WRITTEN_OFF']),
    note: zOptText,
    writeOffDevice: zBool,
  }),
  async ({ id, status, note, writeOffDevice }, user) =>
    transaction(async (tx) => {
      await changeServiceStatus(tx, user, id, status, { note, writeOffDevice });
      return { message: 'Status naloga promijenjen.' };
    }),
);

export const returnDeviceAction = action(
  { module: 'service', level: 'edit' },
  z.object({ id: zId, target: z.enum(['SOLD', 'RENTED', 'IN_STOCK']), warehouseId: zOptId }),
  async ({ id, target, warehouseId }, user) =>
    transaction(async (tx) => {
      await returnDevice(tx, user, id, target, warehouseId);
      return { message: 'Uređaj je vraćen.' };
    }),
);

export const replaceDeviceAction = action(
  { module: 'service', level: 'edit' },
  z.object({ id: zId, replacementId: zId, originalTo: z.enum(['WRITTEN_OFF', 'IN_STOCK']), warehouseId: zOptId, note: zOptText }),
  async ({ id, ...input }, user) =>
    transaction(async (tx) => {
      await replaceDevice(tx, user, id, input);
      return { message: 'Zamjenski uređaj je povezan, nalog je zatvoren.' };
    }),
);

/** Podaci o odabranom uređaju za obrazac novog naloga (jamstvo, klijent, otvoreni nalog). */
export const deviceInfoAction = action({ module: 'service', level: 'view' }, z.object({ id: zId }), async ({ id }, user) => {
  const i = await itemForService(user.companyId, id);
  if (!i) return { revalidate: [], data: null };
  const end = deviceWarrantyEnd(i);
  return {
    revalidate: [],
    data: {
      id: i.id,
      serial: i.serial,
      model: modelLabel(i.model),
      state: i.state,
      status: i.status.name,
      partner: i.partner?.name ?? null,
      contract: i.contractItem?.contract.number ?? null,
      warrantyEnd: end,
      underWarranty: !!end && end >= today(),
      openOrder: i.serviceOrders[0] ?? null,
    },
  };
});

/** Brisanje naloga (C7) — ne za nalog zatvoren zamjenom ni dok je uređaj po njemu u servisu. */
export const deleteServiceAction = action({ module: 'service', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    const number = await deleteServiceOrder(tx, user, id);
    return { message: `Servisni nalog ${number} obrisan.`, redirect: '/servis' };
  }),
);
