import 'server-only';
import { db } from '../db';
import { audit } from '../audit';
import { reconcileAllGoodsExpenses } from '../services/goods-expense';
import type { Actor } from '../services/items';

/**
 * Jednokratno usklađivanje troška robe (verzija s jednim pravilom po narudžbenici): stari
 * podaci s dvostruko knjiženim troškom (primka + račun) usklađuju se sami pri prvom pokretanju,
 * ne tek pri sljedećoj promjeni narudžbenice. Svaka firma jednom — oznaka je zapis u dnevniku
 * (entity `job`, entityId `goods-reconcile-v1`) upisan u istoj transakciji pod advisory lockom,
 * pa ga dva procesa ne rade oba. Ponovni prolaz (npr. nakon čišćenja dnevnika) ne mijenja ništa.
 */
export const GOODS_RECONCILE_KEY = 'goods-reconcile-v1';
const ACTOR_NAME = 'Automatsko usklađivanje';

let done = false;

export async function runGoodsReconcileOnce(): Promise<Array<{ companyId: string; groups: number }>> {
  if (done) return [];
  const out: Array<{ companyId: string; groups: number }> = [];
  const companies = await db.company.findMany({ select: { id: true } });
  for (const { id: companyId } of companies) {
    const marked = await db.auditLog.findFirst({ where: { companyId, entity: 'job', entityId: GOODS_RECONCILE_KEY }, select: { id: true } });
    if (marked) continue;
    const u = await db.user.findFirst({
      where: { OR: [{ companyId }, { companies: { some: { companyId } } }], active: true, role: { in: ['ADMIN', 'MANAGER'] } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (!u) continue;
    const actor: Actor = { id: u.id, name: ACTOR_NAME, companyId };
    const groups = await db.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${`${GOODS_RECONCILE_KEY}:${companyId}`})) AS ok`;
        if (!lock?.ok) return null;
        const again = await tx.auditLog.findFirst({ where: { companyId, entity: 'job', entityId: GOODS_RECONCILE_KEY }, select: { id: true } });
        if (again) return null;
        const n = await reconcileAllGoodsExpenses(tx, actor);
        await audit(tx, actor, { entity: 'job', entityId: GOODS_RECONCILE_KEY, action: 'goods-reconcile', summary: `Jednokratno usklađivanje troška robe po narudžbenicama: usklađeno ${n}` });
        return n;
      },
      { maxWait: 10_000, timeout: 300_000 },
    );
    if (groups !== null) out.push({ companyId, groups });
  }
  done = true;
  return out;
}
