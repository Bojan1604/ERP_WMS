'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zInt, zMoney, zOptText, zReq, zText } from '@/server/zod';
import { saveCompany } from '@/server/services/settings';

const schema = z.object({
  name: zReq('Naziv firme'),
  oib: zOptText,
  vatId: zOptText,
  address: zOptText,
  zip: zOptText,
  city: zOptText,
  country: zReq('Država'),
  iban: zOptText,
  bank: zOptText,
  email: zOptText,
  phone: zOptText,
  web: zOptText,
  // „keep" = logo se ne mijenja, prazno = ukloni
  logo: z.preprocess((v) => (v === 'keep' ? undefined : v === '' ? null : v), z.string().nullable().optional()),
  currency: zReq('Valuta'),
  vatRegistered: zBool,
  vatRate: zMoney,
  overdueDays: zInt.refine((v) => v >= 0 && v <= 3650, 'Neispravan broj dana'),
  paymentTermDays: zInt.refine((v) => v >= 0 && v <= 365, 'Rok plaćanja mora biti 0–365 dana'),
  quoteValidDays: zInt.refine((v) => v >= 0 && v <= 365, 'Valjanost ponude mora biti 0–365 dana'),
  defaultMarginPct: zMoney,
  defaultWarrantyMonths: zInt.refine((v) => v >= 0 && v <= 240, 'Neispravno jamstvo'),
  rentFallbackPct: zMoney,
  invoicePremises: zReq('Oznaka poslovnog prostora'),
  invoiceDevice: zReq('Oznaka naplatnog uređaja'),
  invoiceSeparator: zText.pipe(z.string().min(1, 'Razdjelnik je obavezan').max(3)),
  invoiceFooter: zOptText,
  statusChangeNeedsApproval: zBool,
});

export const saveCompanyAction = action({ module: 'settings', level: 'edit' }, schema, async (input, user) => {
  await transaction((tx) => saveCompany(tx, user, input));
  return { message: 'Postavke spremljene.' };
});
