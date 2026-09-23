'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { assert } from '@/server/errors';
import { audit } from '@/server/audit';
import { zBool, zId, zInt, zMoney, zOptId, zOptInt, zOptMoney, zOptText, zReq } from '@/server/zod';
import {
  deleteLookup, saveCategory, saveExpenseCategory, saveModel, saveService, saveStatus, saveWarehouse,
} from '@/server/services/settings';

const STATUS_KINDS = ['IN_STOCK', 'RESERVED', 'SOLD', 'RENTED', 'SERVICE', 'RETURNING', 'WRITTEN_OFF', 'OTHER'] as const;
const COLORS = ['gray', 'green', 'blue', 'purple', 'red', 'amber', 'teal', 'orange'] as const;

const schemas = {
  warehouse: z.object({ name: zReq('Naziv'), address: zOptText, active: zBool, sort: zInt }),
  category: z.object({ name: zReq('Naziv'), sort: zInt }),
  model: z.object({
    brand: zOptText,
    name: zReq('Naziv'),
    code: zOptText,
    categoryId: zOptId,
    kpd: zOptText,
    salePrice: zOptMoney,
    rentPrice: zOptMoney,
    marginPct: zOptMoney,
    warrantyMonths: zOptInt,
    minStock: zInt,
    specs: zOptText,
    active: zBool,
  }),
  status: z.object({ name: zReq('Naziv'), kind: z.enum(STATUS_KINDS), color: z.enum(COLORS), sort: zInt }),
  service: z.object({ name: zReq('Naziv'), unit: zReq('Jedinica'), price: zMoney, kpd: zOptText, active: zBool }),
  expenseCategory: z.object({ name: zReq('Naziv') }),
};

const entity = z.enum(['warehouse', 'category', 'model', 'status', 'service', 'expenseCategory']);

export const saveLookupAction = action(
  { module: 'settings', level: 'edit' },
  z.object({ entity, id: zOptId, values: z.record(z.unknown()), applyRent: zBool.optional() }),
  async ({ entity, id, values, applyRent }, user) =>
    transaction(async (tx) => {
      switch (entity) {
        case 'warehouse':
          await saveWarehouse(tx, user, id, schemas.warehouse.parse(values));
          break;
        case 'category':
          await saveCategory(tx, user, id, schemas.category.parse(values));
          break;
        case 'model': {
          const r = await saveModel(tx, user, id, schemas.model.parse(values), { applyRent });
          return { message: r.applied ? `Model spremljen; najam primijenjen na ${r.applied} uređaja.` : 'Model spremljen.' };
        }
        case 'status':
          await saveStatus(tx, user, id, schemas.status.parse(values));
          break;
        case 'service':
          await saveService(tx, user, id, schemas.service.parse(values));
          break;
        case 'expenseCategory':
          await saveExpenseCategory(tx, user, id, schemas.expenseCategory.parse(values));
          break;
      }
      return { message: 'Spremljeno.' };
    }),
);

export const deleteLookupAction = action({ module: 'settings', level: 'edit' }, z.object({ entity, id: zId }), async ({ entity, id }, user) => {
  await transaction((tx) => deleteLookup(tx, user, entity, id));
  return { message: 'Obrisano.' };
});

/** Brza (de)aktivacija za zapise koji imaju oznaku „aktivan". */
export const setActiveAction = action(
  { module: 'settings', level: 'edit' },
  z.object({ entity: z.enum(['warehouse', 'model', 'service']), id: zId, active: z.boolean() }),
  async ({ entity, id, active }, user) =>
    transaction(async (tx) => {
      const where = { id, companyId: user.companyId };
      if (entity === 'warehouse') {
        const w = await tx.warehouse.findFirst({ where });
        assert(w, 'Skladište ne postoji.');
        await saveWarehouse(tx, user, id, { name: w.name, address: w.address, sort: w.sort, active });
      } else if (entity === 'model') {
        const r = await tx.deviceModel.updateMany({ where, data: { active } });
        assert(r.count, 'Model ne postoji.');
        await audit(tx, user, { entity: 'model', entityId: id, action: 'update', summary: `Model ${active ? 'aktiviran' : 'deaktiviran'}`, diff: { active: { from: !active, to: active } } });
      } else {
        const r = await tx.service.updateMany({ where, data: { active } });
        assert(r.count, 'Usluga ne postoji.');
        await audit(tx, user, { entity: 'service', entityId: id, action: 'update', summary: `Usluga ${active ? 'aktivirana' : 'deaktivirana'}`, diff: { active: { from: !active, to: active } } });
      }
      return { message: active ? 'Aktivirano.' : 'Deaktivirano — više se ne nudi pri unosu.' };
    }),
);
