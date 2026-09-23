'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { assert } from '@/server/errors';
import { zId } from '@/server/zod';
import {
  addDevices, createContract, removeFromContract, setContractStatus, terminateContract, updateContractItems, updateContractTerms,
} from '@/server/services/rentals';
import { deviceCandidates, type Candidate } from '@/server/queries/rentals';
import { validatePlan } from '@/domain/plan';
import type { PlanPeriodInput } from '@/domain/billing';
import { addSchema, createSchema, itemsPatchSchema, termsSchema } from '../schemas';

const cleanPlan = (plan: z.infer<typeof addSchema>['plan']): PlanPeriodInput[] => {
  const out = plan.map((p) => {
    const r: PlanPeriodInput = { from: p.from, billing: p.billing };
    if (p.to) r.to = p.to;
    if (p.price !== null && p.price !== undefined) r.price = p.price;
    if (p.seasonFrom !== null && p.seasonFrom !== undefined) {
      r.seasonFrom = p.seasonFrom;
      r.seasonTo = p.seasonTo ?? 0;
    }
    return r;
  });
  const err = validatePlan(out);
  assert(!err, err ?? '');
  return out;
};

const url = (id: string, tab?: string) => `/najam/ugovori/${id}${tab ? `?tab=${tab}` : ''}`;

export const createContractAction = action({ module: 'rentals', level: 'edit' }, createSchema, async (input, user) => {
  const { items, ...terms } = input;
  const c = await transaction((tx) => createContract(tx, user, terms));
  const next = items.length ? `${url(c.id, 'uredaji')}&dodaj=${items.join(',')}` : url(c.id, items.length ? 'uredaji' : undefined);
  return { message: `Ugovor ${c.number} otvoren.`, redirect: next, data: { id: c.id } };
});

export const updateTermsAction = action({ module: 'rentals', level: 'edit' }, termsSchema.extend({ id: zId }), async ({ id, ...terms }, user) => {
  await transaction((tx) => updateContractTerms(tx, user, id, terms));
  return { message: 'Uvjeti ugovora spremljeni.' };
});

export const contractStatusAction = action(
  { module: 'rentals', level: 'edit' },
  z.object({ id: zId, status: z.enum(['ACTIVE', 'PAUSED', 'EXPIRED']) }),
  async ({ id, status }, user) => {
    await transaction((tx) => setContractStatus(tx, user, id, status));
    return { message: { ACTIVE: 'Ugovor nastavljen.', PAUSED: 'Ugovor pauziran.', EXPIRED: 'Ugovor označen kao istekao.' }[status] };
  },
);

export const terminateAction = action(
  { module: 'rentals', level: 'edit' },
  z.object({ id: zId, returnNow: z.boolean() }),
  async ({ id, returnNow }, user) => {
    const r = await transaction((tx) => terminateContract(tx, user, id, { returnNow }));
    return { message: r.returned ? `Ugovor otkazan, ${r.returned} uređaja najavljeno za povrat.` : 'Ugovor otkazan.' };
  },
);

export const itemsPatchAction = action({ module: 'rentals', level: 'edit' }, itemsPatchSchema, async (input, user) => {
  assert(input.ids.length, 'Odaberite barem jedan uređaj.');
  const patch: Parameters<typeof updateContractItems>[4] = {};
  if (input.monthly !== undefined) patch.monthly = input.monthly;
  if (input.plan !== undefined) patch.plan = cleanPlan(input.plan);
  if (input.status !== undefined) patch.status = input.status === 'PAUSED' ? 'PAUSED' : null;
  await transaction((tx) => updateContractItems(tx, user, input.contractId, input.ids, patch));
  return { message: `Izmijenjeno uređaja: ${input.ids.length}.` };
});

export const removeItemsAction = action(
  { module: 'rentals', level: 'edit' },
  z.object({ contractId: zId, ids: z.array(zId).min(1) }),
  async ({ contractId, ids }, user) => {
    const n = await transaction((tx) => removeFromContract(tx, user, contractId, ids));
    return { message: `Najavljen povrat ${n} uređaja — ostaju na ugovoru do zaprimanja u skladištu.` };
  },
);

export const addDevicesAction = action({ module: 'rentals', level: 'edit' }, addSchema, async (input, user) => {
  const plan = cleanPlan(input.plan);
  const r = await transaction((tx) =>
    addDevices(tx, user, input.contractId, input.rows.map((row) => ({ ...row, plan })), { skipPast: input.skipPast }),
  );
  return {
    message: `Dodano uređaja: ${r.count}.${r.skipped ? ` Prošla razdoblja (${r.skipped}) označena kao izdana.` : ''}`,
    redirect: url(input.contractId, 'uredaji'),
  };
});

export const searchCandidatesAction = action(
  { module: 'rentals', level: 'view' },
  z.object({ contractId: zId, source: z.enum(['stock', 'partner', 'all']), q: z.string().max(100) }),
  async (input, user): Promise<Candidate[]> => deviceCandidates(user.companyId, input.contractId, input),
);
