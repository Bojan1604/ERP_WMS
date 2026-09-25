'use server';

import { z } from 'zod';
import { optOib, paymentModelOk } from '@/lib/zod-checks';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { zBool, zInt, zMoney, zOptText, zReq, zText } from '@/server/zod';
import { saveCompany, saveCompanyDocs, setCounterStart } from '@/server/services/settings';
import { autoIssueCompany } from '@/server/jobs/auto-issue';

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
  accountantEmail: zOptText.refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Neispravna e-adresa'),
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

// ---------------------------------------------------------------- dokumenti, porez, eRačun, najam (F9)

const zKpd = zOptText.refine((v) => !v || /^\d\d\.\d\d\.\d\d$/.test(v), 'KPD šifra je oblika 00.00.00');

export const saveCompanyDocsAction = action(
  { module: 'settings', level: 'edit' },
  z.object({
    swift: zOptText,
    proformaTitle: zText.pipe(z.string().max(60, 'Naslov je predug')),
    eInvoicePaymentMeans: z.enum(['30', '58'], { message: 'Način plaćanja mora biti 30 ili 58' }),
    paymentModel: zReq('Model poziva na broj').refine(paymentModelOk, 'Model mora biti oblika HR00 – HR99'),
    operatorName: zOptText,
    operatorOib: zOptText.refine(optOib, 'OIB mora imati 11 znamenki'),
    vatTextEuGoods: zOptText,
    vatTextEuService: zOptText,
    vatTextThirdGoods: zOptText,
    vatTextThirdService: zOptText,
    legalFooter: zOptText,
    autoIssueRent: zBool,
    vatOnPayment: zBool,
    kpdRent: zKpd,
    kpdSale: zKpd,
    kpdService: zKpd,
    eInvoiceAttachPdf: zBool,
    eReportingEnabled: zBool,
  }),
  async (input, user) => {
    await transaction((tx) => saveCompanyDocs(tx, user, input));
    return { message: 'Postavke dokumenata spremljene.' };
  },
);

/** Nastavak numeracije: sljedeći broj u seriji (ne ispod već izdanih). */
export const setCounterAction = action(
  { module: 'settings', level: 'edit' },
  z.object({
    series: z.enum(['INVOICE', 'QUOTE', 'PROFORMA', 'CONTRACT', 'ORDER', 'RECEIPT', 'TRANSFER', 'SERVICE', 'SUPPLIER_INVOICE', 'STOCKTAKE']),
    year: zInt,
    next: zInt,
  }),
  async ({ series, year, next }, user) => {
    await transaction((tx) => setCounterStart(tx, user, series, year, next));
    return { message: `Sljedeći broj je ${next}.` };
  },
);

/** „Pokreni sada": automatsko izdavanje dospjelih rata najma za ovu firmu (i kad je danas već pokrenuto). */
export const runAutoIssueAction = action({ module: 'sales', level: 'edit' }, z.object({}), async (_i, user) => {
  const r = await autoIssueCompany(user.companyId, { force: true });
  const list = r.issued.length > 5 ? `${r.issued.slice(0, 5).join(', ')}…` : r.issued.join(', ');
  if (r.alreadyRan) return { message: 'Izdavanje upravo radi drugi proces — pokušajte za minutu.' };
  return {
    message: `${r.issued.length ? `Izdano računa: ${r.issued.length} (${list}).` : 'Nema dospjelih rata za izdati.'}${r.errors.length ? ` Grešaka: ${r.errors.length} — vidi dnevnik promjena.` : ''}`,
  };
});
