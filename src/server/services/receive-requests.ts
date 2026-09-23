import 'server-only';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { assert, DomainError } from '../errors';
import { changeItemStatus, type Actor } from './items';
import { addAttachments, copyAttachment } from './attachments';
import { MAX_RECEIVE, parseSerials, STATE_LABEL } from '@/domain/warehouse';
import { BACK_TO_STOCK_STATES, readReceivePayload, type ReceiveRequestPayload, type RequestPhoto } from '@/domain/receive-request';

/**
 * Zahtjev za zaprimanje robe: skladištar s operativnom razinom skenira robu,
 * a administrator je zaprima (novi uređaji kroz primku, poznati se vraćaju na
 * stanje). Uređaji ne nastaju dok administrator ne potvrdi.
 */

export interface ReceiveRequestInput {
  serials: string[];
  returning: string[];
  warehouseId: string;
  note: string | null;
  photos: Array<{ code: string | null; itemId: string | null; fileName: string | null; data: Uint8Array<ArrayBuffer> }>;
}

export async function createReceiveRequest(tx: Tx, actor: Actor, input: ReceiveRequestInput) {
  const serials = parseSerials(input.serials.join('\n')).serials;
  const returningIds = [...new Set(input.returning)];
  assert(serials.length || returningIds.length, 'Nema ničega za zaprimiti — skenirajte nepoznate uređaje ili uređaje koji se vraćaju.');
  assert(serials.length <= MAX_RECEIVE, `Najviše ${MAX_RECEIVE} serijskih brojeva odjednom.`);

  const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: actor.companyId }, select: { id: true } });
  assert(wh, 'Skladište ne postoji.');

  if (returningIds.length) {
    const items = await tx.item.findMany({ where: { companyId: actor.companyId, id: { in: returningIds } }, select: { id: true, serial: true, state: true } });
    assert(items.length === returningIds.length, 'Neki od skeniranih uređaja više ne postoje.');
    const bad = items.filter((i) => !BACK_TO_STOCK_STATES.includes(i.state));
    if (bad.length) {
      throw new DomainError(`Ovi uređaji se ne vraćaju na skladište: ${bad.slice(0, 10).map((i) => `${i.serial} (${STATE_LABEL[i.state].toLowerCase()})`).join(', ')}.`);
    }
  }

  // serijski koji su u međuvremenu zaprimljeni nisu više „nepoznati"
  const known = serials.length
    ? new Set((await tx.item.findMany({ where: { companyId: actor.companyId, serial: { in: serials } }, select: { serial: true } })).map((i) => i.serial))
    : new Set<string>();
  assert(!known.size, `Ovi serijski brojevi već postoje u bazi: ${[...known].slice(0, 10).join(', ')}. Skenirajte ih ponovno pa pošaljite.`);

  const base: ReceiveRequestPayload = {
    serials,
    returning: returningIds,
    warehouseId: wh.id,
    note: input.note,
    photos: [],
    requesterId: actor.id,
  };
  const r = await tx.approvalRequest.create({
    data: { companyId: actor.companyId, kind: 'RECEIVE', payload: base as unknown as Prisma.InputJsonValue, requestedBy: actor.name },
    select: { id: true },
  });

  if (input.photos.length) {
    // skladištar s operativnom razinom smije priložiti slike svom zahtjevu (ne i kasnije ih mijenjati)
    const saved = await addAttachments(tx, actor, 'request', r.id, input.photos.map((p) => ({ fileName: p.fileName ?? (p.code ? `naljepnica ${p.code}` : null), data: p.data })));
    const photos: RequestPhoto[] = saved.map((a, i) => ({
      id: a.id,
      code: input.photos[i].code,
      itemId: input.photos[i].itemId && returningIds.includes(input.photos[i].itemId!) ? input.photos[i].itemId : null,
    }));
    await tx.approvalRequest.update({ where: { id: r.id }, data: { payload: { ...base, photos } as unknown as Prisma.InputJsonValue } });
  }
  return { id: r.id, serials: serials.length, returning: returningIds.length, photos: input.photos.length };
}

async function pendingReceive(tx: Tx, actor: Actor, id: string) {
  const r = await tx.approvalRequest.findFirst({ where: { id, companyId: actor.companyId } });
  assert(r && r.kind === 'RECEIVE', 'Zahtjev za zaprimanje ne postoji.');
  assert(r.status === 'PENDING', 'Zahtjev je već riješen.');
  return { ...r, p: readReceivePayload(r.payload) };
}

/** Zahtjev za zaprimanje na čekanju (za obrazac zaprimanja). */
export async function receiveRequestForForm(tx: Tx, actor: Actor, id: string) {
  const r = await tx.approvalRequest.findFirst({ where: { id, companyId: actor.companyId, kind: 'RECEIVE', status: 'PENDING' } });
  return r ? { id: r.id, requestedBy: r.requestedBy, createdAt: r.createdAt, ...readReceivePayload(r.payload) } : null;
}

/**
 * Odobrenje zahtjeva: poznati uređaji iz zahtjeva vraćaju se na stanje u
 * odabrano skladište, slike naljepnica prelaze na uređaje, a zahtjev postaje
 * odobren. Novi uređaji nastaju prije ovoga, primkom (`receiveItems`) u istoj
 * transakciji — `receiptId` ih povezuje.
 */
export async function approveReceiveRequest(tx: Tx, actor: Actor, id: string, opts: { warehouseId: string; receiptId?: string | null; receiptNumber?: string | null }) {
  const r = await pendingReceive(tx, actor, id);
  const w = await tx.warehouse.findFirst({ where: { id: opts.warehouseId, companyId: actor.companyId }, select: { id: true, name: true } });
  assert(w, 'Skladište ne postoji.');
  assert(opts.receiptId || r.p.returning.length, 'Zahtjev sadrži nove serijske brojeve — zaprimite ih kroz „Provjeri i zaprimi".');

  // poznati uređaji: preskaču se oni koji su u međuvremenu već na skladištu ili obrisani
  const back = r.p.returning.length
    ? await tx.item.findMany({ where: { companyId: actor.companyId, id: { in: r.p.returning }, state: { in: BACK_TO_STOCK_STATES } }, select: { id: true, serial: true } })
    : [];
  if (back.length) {
    await changeItemStatus(tx, actor, back.map((i) => i.id), {
      kind: 'IN_STOCK',
      data: { warehouseId: w.id },
      event: { type: 'RETURNED', message: `Vraćen na skladište „${w.name}" — zahtjev za zaprimanje (${r.requestedBy})` },
    });
  }

  // slike naljepnica → prilozi uređaja (novih iz primke i vraćenih)
  const created = opts.receiptId
    ? await tx.item.findMany({ where: { companyId: actor.companyId, receiptId: opts.receiptId }, select: { id: true, serial: true } })
    : [];
  const bySerial = new Map([...created, ...back].map((i) => [i.serial.toUpperCase(), i.id]));
  const backIds = new Set(back.map((i) => i.id));
  let photos = 0;
  for (const ph of r.p.photos) {
    const target = (ph.itemId && backIds.has(ph.itemId) ? ph.itemId : null) ?? (ph.code ? bySerial.get(ph.code.trim().toUpperCase()) : undefined);
    if (target) photos += await copyAttachment(tx, actor, ph.id, 'item', target, `Zaprimanje ${ph.code ?? ''}`.trim());
  }

  const summary = [opts.receiptNumber && `primka ${opts.receiptNumber} (${created.length} kom)`, back.length && `vraćeno na skladište ${back.length} kom`].filter(Boolean).join(', ');
  const upd = await tx.approvalRequest.updateMany({
    where: { id: r.id, status: 'PENDING' },
    data: { status: 'APPROVED', resolvedBy: actor.name, resolvedAt: new Date(), resolveNote: summary ? `Zaprimljeno: ${summary}` : null },
  });
  assert(upd.count === 1, 'Zahtjev je već riješen.');
  return { returned: back.length, created: created.length, photos, requestedBy: r.requestedBy, warehouse: w.name };
}

/**
 * Podnositelj potvrđuje da je vidio odbijeni zahtjev (traka na skeniranju nestaje).
 * Podnositelj se prepoznaje po id-u; stariji zahtjev bez id-a podnositelja može
 * potvrditi samo korisnik s pravom uređivanja skladišta (`canManage`).
 */
export async function ackRequest(tx: Tx, actor: Actor, id: string, opts: { canManage?: boolean } = {}) {
  const r = await tx.approvalRequest.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, status: true, payload: true, requestedBy: true } });
  assert(r, 'Zahtjev ne postoji.');
  const p = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, unknown>;
  assert(p.requesterId ? p.requesterId === actor.id : !!opts.canManage, 'Potvrditi može samo podnositelj zahtjeva.');
  assert(r.status !== 'PENDING', 'Zahtjev još nije riješen.');
  await tx.approvalRequest.update({ where: { id: r.id }, data: { payload: { ...p, ack: true } as Prisma.InputJsonValue } });
}
