import 'server-only';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { AuthError, DomainError } from '../errors';
import { COMMANDS, canSendCommand, type CommandType } from '@/domain/mdm';
import type { MdmScope } from './scope';
import { deviceWhere } from './scope';
import { sameJson } from './stable';

/**
 * Naredbe uređajima idu u red (MdmCommand) i agent ih preuzima pri javljanju.
 * Ista naredba koja još čeka ne dodaje se dvaput (npr. dvostruki klik na Reboot).
 */
export async function queueCommands(
  tx: Tx,
  scope: MdmScope,
  deviceIds: string[],
  type: CommandType,
  payload: Prisma.InputJsonValue = {},
) {
  const def = COMMANDS[type];
  if (!def) throw new DomainError('Nepoznata naredba.');
  const ids = [...new Set(deviceIds)];
  if (!ids.length) throw new DomainError('Niste odabrali nijedan uređaj.');
  if (ids.length > 1000) throw new DomainError('Najviše 1000 uređaja odjednom.');
  const devices = await tx.mdmDevice.findMany({
    where: { id: { in: ids }, ...deviceWhere(scope) },
    select: { id: true, platform: true, status: true, name: true },
  });
  if (devices.length !== ids.length) throw new AuthError('Neki uređaji nisu dostupni.', 403);

  const allowed = devices.filter((d) => canSendCommand(type, d.platform, scope.level, scope.owner));
  if (!allowed.length) throw new AuthError(`Naredba „${def.label}" nije dopuštena za odabrane uređaje.`, 403);
  const active = allowed.filter((d) => d.status === 'ENROLLED');
  if (!active.length) throw new DomainError('Naredbe se šalju samo upisanim uređajima.');

  const pending = await tx.mdmCommand.findMany({
    where: { deviceId: { in: active.map((d) => d.id) }, type, status: { in: ['PENDING', 'SENT'] } },
    select: { deviceId: true, payload: true },
  });
  const same = new Set(pending.filter((p) => sameJson(p.payload, payload)).map((p) => p.deviceId));
  const targets = active.filter((d) => !same.has(d.id));
  const expiresAt = new Date(Date.now() + def.ttlHours * 3_600_000);
  if (targets.length) {
    await tx.mdmCommand.createMany({
      data: targets.map((d) => ({ deviceId: d.id, type, payload, createdBy: scope.userName, expiresAt })),
    });
    await tx.mdmEvent.createMany({
      data: targets.map((d) => ({ deviceId: d.id, type: 'COMMAND', message: `Naredba: ${def.label} (${scope.userName})` })),
    });
  }
  return { queued: targets.length, skipped: devices.length - targets.length, label: def.label };
}

/** Naredbe koje su predugo čekale označavaju se kao istekle (poziva se pri javljanju agenta). */
export async function expireCommands(tx: Tx, deviceId: string) {
  await tx.mdmCommand.updateMany({
    where: { deviceId, status: { in: ['PENDING', 'SENT'] }, expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED', doneAt: new Date() },
  });
}
