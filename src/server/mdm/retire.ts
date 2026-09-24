import 'server-only';
import type { Tx } from '../db';
import { deadTokenHash } from './agent-auth';

/** Stablo distributera kojem organizacija pripada: ona, nadređena, i njihovi klijenti. */
export async function orgTree(tx: Tx, orgId: string): Promise<string[]> {
  const org = await tx.mdmOrg.findUnique({ where: { id: orgId }, select: { parentId: true } });
  const roots = [orgId, ...(org?.parentId ? [org.parentId] : [])];
  const children = await tx.mdmOrg.findMany({ where: { parentId: { in: roots } }, select: { id: true } });
  return [...new Set([...roots, ...children.map((c) => c.id)])];
}

/**
 * Isti fizički uređaj (hardwareId + platforma) ima najviše jedan živi zapis u firmi.
 * Kad se agent ponovno upiše u novi zapis, stari zapisi se odjavljuju (poništen ključ,
 * otkazane naredbe); povijest ostaje uz stari zapis i njegovu organizaciju.
 * `orgIds` sužava na zapise tih organizacija (i one bez organizacije) — hardwareId šalje agent,
 * pa se tuđi uređaji izvan dosega onoga tko upisuje ne diraju; null = cijela firma.
 */
export async function retireDuplicates(
  tx: Tx,
  device: { companyId: string; hardwareId: string | null; platform: 'ANDROID' | 'WINDOWS'; keepId: string; orgIds: string[] | null },
  statuses: Array<'ENROLLED' | 'PENDING'>,
  reason: string,
  now = new Date(),
) {
  if (!device.hardwareId || !statuses.length) return 0;
  const stale = await tx.mdmDevice.findMany({
    where: { companyId: device.companyId, hardwareId: device.hardwareId, platform: device.platform, status: { in: statuses }, id: { not: device.keepId }, ...(device.orgIds ? { OR: [{ orgId: null }, { orgId: { in: device.orgIds } }] } : {}) },
    select: { id: true },
  });
  for (const d of stale) {
    await tx.mdmDevice.update({ where: { id: d.id }, data: { status: 'RETIRED', tokenHash: deadTokenHash(), enrollCode: null, onlineSince: null }, select: { id: true } });
  }
  if (!stale.length) return 0;
  const ids = stale.map((d) => d.id);
  await tx.mdmCommand.updateMany({
    where: { deviceId: { in: ids }, status: { in: ['PENDING', 'SENT'] } },
    data: { status: 'CANCELLED', doneAt: now, error: reason },
  });
  await tx.mdmEvent.createMany({ data: ids.map((deviceId) => ({ deviceId, at: now, type: 'RETIRED', level: 'warn', message: reason })) });
  return stale.length;
}
