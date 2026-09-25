'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zId, zOptMoney } from '@/server/zod';
import { setRentOverride } from '@/server/services/rentals';
import { setRentOverrides } from '@/server/services/contract-admin';

export const rentOverrideAction = action(
  { module: 'rentals', level: 'edit' },
  z.object({ itemId: zId, year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), amount: zOptMoney }),
  async (input, user) => {
    await transaction((tx) => setRentOverride(tx, user, input));
    return { message: input.amount === null ? 'Ručni iznos uklonjen.' : 'Ručni iznos spremljen.', revalidate: ['/najam/pregled'] };
  },
);

/** Skupni upis u mrežu najma (C4): isti iznos u označena polja ili „Auto" (null) — briše ručne upise. */
export const rentOverridesBulkAction = action(
  { module: 'rentals', level: 'edit' },
  z.object({
    year: z.number().int().min(2000).max(2100),
    cells: z.array(z.object({ itemId: zId, month: z.number().int().min(1).max(12) })).min(1, 'Označite barem jedno polje').max(5000, 'Najviše 5000 polja odjednom'),
    amount: zOptMoney,
  }),
  async (input, user) => {
    const n = await transaction((tx) => setRentOverrides(tx, user, input));
    return {
      message: input.amount === null ? `${n} polja vraćeno na automatski izračun.` : `${n} polja upisano.`,
      revalidate: ['/najam/pregled'],
    };
  },
);
