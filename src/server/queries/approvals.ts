import 'server-only';
import type { ApprovalRequest, Prisma } from '@prisma/client';
import { db } from '../db';
import { readReceivePayload } from '@/domain/receive-request';

// ---------------------------------------------------------------- odobrenja (promjena statusa i zaprimanje)

export interface StatusChangePayload {
  itemIds: string[];
  statusId: string;
  note?: string | null;
  requesterId?: string | null;
  ack?: boolean;
}

const statusPayload = (p: unknown) => (p && typeof p === 'object' ? p : {}) as StatusChangePayload;

const itemSelect = {
  id: true, serial: true, dupNote: true, state: true, contractItem: { select: { contractId: true } }, status: { select: { name: true, color: true } },
} satisfies Prisma.ItemSelect;

/**
 * Je li zahtjev poslao ovaj korisnik — samo po id-u podnositelja. Ime nije
 * jedinstveno (dva „Ivana" bi vidjela tuđe zahtjeve i slike), pa stariji
 * zapisi bez id-a nisu ničiji „moji" — vide ih samo korisnici s pravom
 * uređivanja skladišta (oni vide sve zahtjeve firme).
 */
export function isMine(r: Pick<ApprovalRequest, 'payload'>, user: { id: string }) {
  const id = r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>).requesterId : null;
  return typeof id === 'string' && !!id && id === user.id;
}

const mineWhere = (userId: string) => ({ payload: { path: ['requesterId'], equals: userId } }) satisfies Prisma.ApprovalRequestWhereInput;

/**
 * Zahtjevi za stranicu Odobrenja. Bez `mine` — svi zahtjevi firme (administrator);
 * s `mine` — samo zahtjevi tog korisnika (skladištar vidi ishod i razlog odbijanja).
 */
export async function approvalRequests(companyId: string, opts: { mine?: { id: string; name: string } } = {}) {
  let pending: ApprovalRequest[];
  let resolved: ApprovalRequest[];
  if (opts.mine) {
    const me = opts.mine;
    const rows = await db.approvalRequest.findMany({
      where: { companyId, ...mineWhere(me.id) },
      orderBy: { createdAt: 'desc' },
      take: 80,
    });
    const mine = rows.filter((r) => isMine(r, me));
    pending = mine.filter((r) => r.status === 'PENDING');
    resolved = mine.filter((r) => r.status !== 'PENDING').slice(0, 30);
  } else {
    [pending, resolved] = await Promise.all([
      db.approvalRequest.findMany({ where: { companyId, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200 }),
      db.approvalRequest.findMany({ where: { companyId, status: { not: 'PENDING' } }, orderBy: { resolvedAt: 'desc' }, take: 30 }),
    ]);
  }
  const all = [...pending, ...resolved];
  const receive = all.filter((r) => r.kind === 'RECEIVE');
  const itemIds = [
    ...new Set(
      all.flatMap((r) => (r.kind === 'RECEIVE' ? readReceivePayload(r.payload).returning : statusPayload(r.payload).itemIds ?? [])),
    ),
  ];
  const [items, statuses, warehouses, photos] = await Promise.all([
    itemIds.length ? db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: itemSelect }) : [],
    db.itemStatus.findMany({ where: { companyId }, select: { id: true, name: true, color: true, kind: true } }),
    db.warehouse.findMany({ where: { companyId }, select: { id: true, name: true } }),
    receive.length
      ? db.attachment.findMany({
          where: { companyId, entity: 'request', entityId: { in: receive.map((r) => r.id) } },
          select: { id: true, entityId: true, fileName: true, mime: true, size: true },
          orderBy: { createdAt: 'asc' },
        })
      : [],
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const st = new Map(statuses.map((s) => [s.id, s]));
  const wh = new Map(warehouses.map((w) => [w.id, w]));
  const pick = (ids: string[]) => ({
    items: ids.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x),
    missing: ids.filter((id) => !byId.has(id)).length,
  });

  const shape = (r: ApprovalRequest) => {
    const common = {
      id: r.id,
      status: r.status,
      requestedBy: r.requestedBy,
      resolvedBy: r.resolvedBy,
      resolveNote: r.resolveNote,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
    };
    if (r.kind === 'RECEIVE') {
      const p = readReceivePayload(r.payload);
      const meta = new Map(photos.filter((a) => a.entityId === r.id).map((a) => [a.id, a]));
      return {
        ...common,
        kind: 'RECEIVE' as const,
        note: p.note,
        ack: !!p.ack,
        serials: p.serials,
        warehouse: wh.get(p.warehouseId) ?? null,
        ...pick(p.returning),
        photos: p.photos.flatMap((ph) => {
          const a = meta.get(ph.id);
          return a ? [{ ...ph, fileName: a.fileName, mime: a.mime, size: a.size }] : [];
        }),
      };
    }
    const p = statusPayload(r.payload);
    return {
      ...common,
      kind: 'STATUS_CHANGE' as const,
      note: p.note ?? null,
      ack: !!p.ack,
      target: st.get(p.statusId) ?? null,
      ...pick(p.itemIds ?? []),
    };
  };
  return { pending: pending.map(shape), resolved: resolved.map(shape) };
}

export type ApprovalRow = Awaited<ReturnType<typeof approvalRequests>>['pending'][number];

/** Odbijeni zahtjevi korisnika koje još nije potvrdio („U redu") — traka na skeniranju. */
export async function unseenRejections(companyId: string, user: { id: string; name: string }) {
  const rows = await db.approvalRequest.findMany({
    where: {
      companyId,
      status: 'REJECTED',
      resolvedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      ...mineWhere(user.id),
    },
    orderBy: { resolvedAt: 'desc' },
    take: 20,
    select: { id: true, kind: true, payload: true, requestedBy: true, resolvedBy: true, resolveNote: true, resolvedAt: true },
  });
  return rows
    .filter((r) => isMine(r, user) && !(r.payload as Record<string, unknown> | null)?.ack)
    .map((r) => {
      const p = r.payload as Record<string, unknown> | null;
      const count = r.kind === 'RECEIVE' ? readReceivePayload(p).serials.length + readReceivePayload(p).returning.length : ((p?.itemIds as string[] | undefined) ?? []).length;
      return { id: r.id, kind: r.kind, count, resolvedBy: r.resolvedBy, resolveNote: r.resolveNote, resolvedAt: r.resolvedAt };
    });
}

/** Broj vlastitih zahtjeva na čekanju (skladištar na skeniranju). */
export async function myPendingCount(companyId: string, user: { id: string; name: string }) {
  const rows = await db.approvalRequest.findMany({
    where: { companyId, status: 'PENDING', ...mineWhere(user.id) },
    select: { payload: true, requestedBy: true },
    take: 200,
  });
  return rows.filter((r) => isMine(r, user)).length;
}
