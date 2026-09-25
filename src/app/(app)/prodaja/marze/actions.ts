'use server';

import { z } from 'zod';
import { optBelow, optNonNegative } from '@/lib/zod-checks';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { assert } from '@/server/errors';
import { audit } from '@/server/audit';
import { zBool, zId, zMoney, zOptId, zOptMoney, zOptText } from '@/server/zod';
import { deletePackage, packageItemIds, packageToDocument, savePackage } from '@/server/services/packages';
import { searchDevices } from '@/server/queries/sales';
import { canSeeCost } from '@/domain/permissions';
import { num } from '@/domain/money';

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
 * Paket: skupina uređaja sa skladišta s cijenom paketa i ukupnom maržom (novi ili
 * izmjena). Iz paketa se poslije izrađuje ponuda, predračun ili nacrt računa.
 */
export const savePackageAction = action(
  { module: 'sales', level: 'edit' },
  z.object({
    id: zOptId,
    name: z.string().trim().min(1, 'Upišite naziv paketa').max(200, 'Naziv je predug'),
    itemIds: z.array(zId).min(1, 'Dodajte barem jedan uređaj').max(300, 'Najviše 300 uređaja u paketu'),
    price: zOptMoney.refine(optNonNegative, 'Cijena ne može biti negativna'),
    note: zOptText,
  }),
  async ({ id, ...input }, user) => {
    assert(canSeeCost(user.perms), 'Nemate pravo na nabavne cijene i marže.');
    return transaction(async (tx) => {
      const p = await savePackage(tx, user, id ?? null, { ...input, note: input.note ?? null });
      return { message: id ? 'Paket je spremljen.' : `Paket „${p.name}" je spremljen.`, data: { id: p.id } };
    });
  },
);

export const deletePackageAction = action({ module: 'sales', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  assert(canSeeCost(user.perms), 'Nemate pravo na nabavne cijene i marže.');
  return transaction(async (tx) => {
    await deletePackage(tx, user, id);
    return { message: 'Paket je obrisan.' };
  });
});

/** Paket → ponuda, predračun ili nacrt računa za kupca (cijene prema kupcu, cijena paketa raspoređena na uređaje). */
export const convertPackageAction = action(
  { module: 'sales', level: 'edit' },
  z.object({ id: zId, partnerId: zId, target: z.enum(['QUOTE', 'PROFORMA', 'INVOICE']) }),
  async ({ id, partnerId, target }, user) => {
    assert(canSeeCost(user.perms), 'Nemate pravo na nabavne cijene i marže.');
    const itemIds = await packageItemIds(db, user.companyId, id);
    assert(itemIds.length, 'Paket nema uređaja.');
    const devices = await searchDevices(user.companyId, { itemIds, partnerId });
    return transaction(async (tx) => {
      const r = await packageToDocument(tx, user, id, partnerId, target, devices);
      return r.kind === 'invoice'
        ? { message: 'Nacrt računa iz paketa je izrađen.', redirect: `/prodaja/racuni/${r.id}` }
        : { message: `${target === 'PROFORMA' ? 'Predračun' : 'Ponuda'} ${r.number} iz paketa je ${target === 'PROFORMA' ? 'izrađen' : 'izrađena'}.`, redirect: `/prodaja/ponude/${r.id}` };
    });
  },
);
