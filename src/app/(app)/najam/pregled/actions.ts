'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zId, zOptMoney } from '@/server/zod';
import { setRentOverride } from '@/server/services/rentals';

export const rentOverrideAction = action(
  { module: 'rentals', level: 'edit' },
  z.object({ itemId: zId, year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), amount: zOptMoney }),
  async (input, user) => {
    await transaction((tx) => setRentOverride(tx, user, input));
    return { message: input.amount === null ? 'Ručni iznos uklonjen.' : 'Ručni iznos spremljen.', revalidate: ['/najam/pregled'] };
  },
);
