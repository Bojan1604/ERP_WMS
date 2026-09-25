import { z } from 'zod';
import { zBool, zDate, zId, zIds, zMoney, zOptDate, zOptInt, zOptMoney, zOptText } from '@/server/zod';

export const zBilling = z.enum(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ONCE']);
export const zBillingMode = z.enum(['IN_ADVANCE', 'IN_ARREARS']);

/** Uvjeti ugovora iz obrasca. */
export const termsSchema = z.object({
  startDate: zDate,
  endDate: zOptDate,
  firstBillingDate: zOptDate,
  billingDay: zOptInt,
  billing: zBilling,
  billingMode: zBillingMode,
  seasonFrom: zOptInt,
  seasonTo: zOptInt,
  note: zOptText,
  /** Ručni broj ugovora; prazno = automatski. */
  number: zOptText.optional(),
});

export const createSchema = termsSchema.extend({
  partnerId: z.string().min(1, 'Klijent je obavezan'),
  items: zIds,
});

/** Razdoblje plana naplate (sezona 0 = cijela godina, prazno = kao ugovor). */
export const planSchema = z.array(
  z.object({
    from: zDate,
    to: zOptDate.optional(),
    billing: zBilling,
    price: zOptMoney.optional(),
    seasonFrom: zOptInt.optional(),
    seasonTo: zOptInt.optional(),
  }),
).max(24);

export const itemsPatchSchema = z.object({
  contractId: zId,
  ids: zIds,
  monthly: zMoney.optional(),
  plan: planSchema.optional(),
  status: z.enum(['PAUSED', 'ACTIVE']).optional(),
  billing: zBilling.optional(),
  season: z.enum(['summer', 'year', 'contract']).optional(),
});

export const addSchema = z.object({
  contractId: zId,
  rows: z.array(z.object({ itemId: zId, monthly: zMoney })).min(1, 'Odaberite barem jedan uređaj'),
  plan: planSchema,
  skipPast: zBool,
});

export const installmentSchema = z.object({ contractId: zId, period: z.string().regex(/^\d{4}-\d{2}$/) });
