'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { zBool, zDate, zId, zMoney, zOptDate, zOptId, zOptText } from '@/server/zod';
import { convertQuote, deleteQuote, saveQuote, setQuoteStatus } from '@/server/services/quotes';
import { getCompany } from '@/server/queries/lookups';
import { num, r2 } from '@/domain/money';
import { priceFromMargin } from '@/domain/pricing';

const zLine = z.object({
  kind: z.enum(['DEVICE', 'MODEL', 'SERVICE', 'MANUAL']),
  itemId: zOptId,
  modelId: zOptId,
  serviceId: zOptId,
  description: z.string().trim().min(1, 'Opis stavke je obavezan'),
  unit: zOptText,
  qty: zMoney,
  unitPrice: zMoney,
  discountPct: zMoney.refine((v) => v >= 0 && v <= 100, 'Popust stavke mora biti između 0 i 100 %'),
});

const zQuote = z.object({
  id: zOptId,
  partnerId: zId,
  date: zDate,
  validUntil: zOptDate,
  vatRate: zMoney.refine((v) => v >= 0 && v <= 100, 'Stopa PDV-a nije ispravna'),
  discountPct: zMoney.refine((v) => v >= 0 && v <= 100, 'Popust mora biti između 0 i 100 %'),
  discountAmount: zMoney.refine((v) => v >= 0, 'Popust ne može biti negativan'),
  hideSerials: zBool,
  note: zOptText,
  lines: z.array(zLine).min(1, 'Ponuda nema stavki'),
});

export const saveQuoteAction = action({ module: 'sales', level: 'edit' }, zQuote, async ({ id, ...input }, user) =>
  transaction(async (tx) => {
    const q = await saveQuote(tx, user, id, input);
    return { message: id ? 'Ponuda je spremljena.' : `Ponuda ${q.number} je izrađena.`, redirect: `/prodaja/ponude/${q.id}`, data: { id: q.id } };
  }),
);

export const setQuoteStatusAction = action(
  { module: 'sales', level: 'edit' },
  z.object({ id: zId, status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED']) }),
  async ({ id, status }, user) =>
    transaction(async (tx) => {
      await setQuoteStatus(tx, user, id, status);
      return { message: 'Status ponude je promijenjen.' };
    }),
);

export const deleteQuoteAction = action({ module: 'sales', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    await deleteQuote(tx, user, id);
    return { message: 'Ponuda je obrisana.', redirect: '/prodaja/ponude' };
  }),
);

/** Pretvaranje u nacrt računa; `picks` = za svaku stavku po modelu odabrani uređaji. */
export const convertQuoteAction = action(
  { module: 'sales', level: 'edit' },
  z.object({ id: zId, picks: z.record(z.array(z.string().min(1))).default({}) }),
  async ({ id, picks }, user) =>
    transaction(async (tx) => {
      const inv = await convertQuote(tx, user, id, picks);
      return { message: 'Nacrt računa je izrađen iz ponude.', redirect: `/prodaja/racuni/${inv.id}` };
    }),
);

/**
 * Cijena stavke po modelu za kupca: dogovorena → cijena modela → iz marže na
 * prosječnu nabavnu uređaja na skladištu. Vraća i broj uređaja na skladištu.
 */
export const modelQuotePrice = action({ module: 'sales', level: 'view' }, z.object({ modelId: zId, partnerId: zOptId }), async ({ modelId, partnerId }, user) => {
  const [model, agreed, stock, company] = await Promise.all([
    db.deviceModel.findFirst({ where: { id: modelId, companyId: user.companyId }, select: { salePrice: true, marginPct: true } }),
    partnerId ? db.priceAgreement.findFirst({ where: { companyId: user.companyId, partnerId, modelId }, select: { salePrice: true } }) : null,
    db.item.aggregate({
      where: { companyId: user.companyId, modelId, state: { in: ['IN_STOCK', 'RESERVED'] }, contractItem: null },
      _avg: { cost: true },
      _count: true,
    }),
    getCompany(user.companyId),
  ]);
  let price = 0;
  let source: 'agreed' | 'model' | 'margin' = 'margin';
  if (agreed?.salePrice && num(agreed.salePrice) > 0) {
    price = num(agreed.salePrice);
    source = 'agreed';
  } else if (model?.salePrice && num(model.salePrice) > 0) {
    price = num(model.salePrice);
    source = 'model';
  } else {
    price = priceFromMargin(num(stock._avg.cost), model?.marginPct ? num(model.marginPct) : num(company.defaultMarginPct));
  }
  return { data: { price: r2(price), source, stock: stock._count }, revalidate: [] };
});
