import 'server-only';
import type { Prisma } from '@prisma/client';
import type { Tx } from './db';
import type { SessionUser } from './auth';

/** Zapis u dnevnik promjena — unutar iste transakcije kao i sama promjena. */
export async function audit(
  tx: Tx,
  user: Pick<SessionUser, 'id' | 'name' | 'companyId'>,
  entry: { entity: string; entityId?: string | null; action: string; summary: string; diff?: Prisma.InputJsonValue },
) {
  await tx.auditLog.create({
    data: {
      companyId: user.companyId,
      userId: user.id,
      userName: user.name,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      action: entry.action,
      summary: entry.summary,
      diff: entry.diff,
    },
  });
}

/** Razlika dvaju zapisa — samo promijenjena polja. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    const a = norm(before[k]);
    const b = norm(after[k]);
    if (a !== b) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}

function norm(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && 'toNumber' in (v as object)) return String((v as { toNumber(): number }).toNumber());
  return String(v);
}
