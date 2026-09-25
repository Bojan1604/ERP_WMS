'use server';

import { z } from 'zod';
import { optBelow, optNonNegative } from '@/lib/zod-checks';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { assert } from '@/server/errors';
import { audit } from '@/server/audit';
import { zBool, zId, zMoney, zOptMoney, zOptText } from '@/server/zod';
import { saveQuote } from '@/server/services/quotes';
import { searchDevices } from '@/server/queries/sales';
import { canSeeCost } from '@/domain/permissions';
import { customerVat } from '@/domain/tax';
import { addDays, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';

const zPct = zMoney.refine((v) => v >= 0 && v < 100, 'Marža mora biti između 0 i 99,99 %');

/**
 * Globalna bruto marža: postavlja zadanu maržu firme; po želji briše marže
 * po modelima i po uređajima (svi se vraćaju na globalnu).
 */
export const setGlobalMarginAction = action(
  { module: 'sales', level: 'edit' },
  z.object({ pct: zPct, resetModels: zBool, resetItems: zBool }),
  async ({ pct, resetModels, resetItems }, user) => {
    assert(canSeeCost(user.perms), 'Nemate pravo na nabavne cijene i marže.');
    return transaction(async (tx) => {
      await tx.company.update({ where: { id: user.companyId }, data: { defaultMarginPct: pct } });
      const models = resetModels ? (await tx.deviceModel.updateMany({ where: { companyId: user.companyId, marginPct: { not: null } }, data: { marginPct: null } })).count : 0;
      const items = resetItems ? (await tx.item.updateMany({ where: { companyId: user.companyId, marginPct: { not: null } }, data: { marginPct: null } })).count : 0;
      await audit(tx, user, {
        entity: 'settings',
        action: 'margin',
        summary: `Globalna bruto marža ${pct} %${models ? ` — marže ${models} modela vraćene na globalnu` : ''}${items ? ` — marže ${items} uređaja vraćene na globalnu` : ''}`,
      });
      return { message: `Globalna bruto marža je ${String(pct).replace('.', ',')} %.` };
    });
  },
);

/** Marža pojedinog modela (prazno = globalna). */
export const setModelMarginAction = action(
  { module: 'sales', level: 'edit' },
  z.object({ modelId: zId, pct: zOptMoney.refine(optBelow(0, 100), 'Marža mora biti između 0 i 99,99 %') }),
  async ({ modelId, pct }, user) => {
    assert(canSeeCost(user.perms), 'Nemate pravo na nabavne cijene i marže.');
    return transaction(async (tx) => {
      const m = await tx.deviceModel.findFirst({ where: { id: modelId, companyId: user.companyId }, select: { id: true, brand: true, name: true, marginPct: true } });
      assert(m, 'Model ne postoji.');
      if ((m.marginPct === null ? null : num(m.marginPct)) === pct) return { message: 'Bez promjene.', revalidate: [] };
      await tx.deviceModel.update({ where: { id: m.id }, data: { marginPct: pct } });
      await audit(tx, user, { entity: 'model', entityId: m.id, action: 'margin', summary: `Marža modela ${[m.brand, m.name].filter(Boolean).join(' ')}: ${pct === null ? 'globalna' : `${pct} %`}` });
      return { message: 'Marža modela je spremljena.' };
    });
  },
);

/**
 * Paket: skupina uređaja sa skladišta s ukupnom maržom — sprema se kao ponuda
 * (nacrt) za kupca. Cijena paketa (ako je zadana) raspoređuje se na uređaje
 * razmjerno preporučenim cijenama.
 */
export const savePackageAction = action(
  { module: 'sales', level: 'edit' },
  z.object({
    partnerId: zId,
    name: z.string().trim().min(1, 'Upišite naziv paketa').max(200),
    itemIds: z.array(zId).min(1, 'Dodajte barem jedan uređaj').max(300),
    price: zOptMoney.refine(optNonNegative, 'Cijena ne može biti negativna'),
    note: zOptText,
  }),
  async ({ partnerId, name, itemIds, price, note }, user) => {
    assert(canSeeCost(user.perms), 'Nemate pravo na nabavne cijene i marže.');
    const devices = await searchDevices(user.companyId, { itemIds, partnerId });
    assert(devices.length === itemIds.length, 'Neki uređaji više nisu na skladištu.');
    const suggested = devices.reduce((a, d) => a + d.price, 0);
    const factor = price !== null && suggested > 0 ? price / suggested : 1;
    return transaction(async (tx) => {
      const [partner, company] = await Promise.all([
        tx.partner.findFirst({ where: { id: partnerId, companyId: user.companyId }, select: { country: true, vatCategoryOverride: true } }),
        tx.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { vatRegistered: true, vatRate: true, country: true, quoteValidDays: true } }),
      ]);
      assert(partner, 'Kupac ne postoji.');
      const date = today();
      const lines = devices.map((d) => ({ kind: 'DEVICE' as const, itemId: d.id, modelId: d.modelId, description: d.model, qty: 1, unitPrice: r2(d.price * factor) }));
      // zaokruživanje: razlika do cijene paketa ide na prvu stavku
      if (price !== null && lines.length) lines[0].unitPrice = r2(lines[0].unitPrice + price - lines.reduce((a, l) => a + l.unitPrice, 0));
      const q = await saveQuote(tx, user, null, {
        partnerId,
        date,
        validUntil: addDays(date, company.quoteValidDays),
        vatRate: customerVat(partner, { vatRegistered: company.vatRegistered, vatRate: num(company.vatRate), country: company.country }).rate,
        note: [`Paket: ${name}`, note].filter(Boolean).join('\n'),
        lines,
      });
      return { message: `Paket je spremljen kao ponuda ${q.number}.`, redirect: `/prodaja/ponude/${q.id}` };
    });
  },
);
