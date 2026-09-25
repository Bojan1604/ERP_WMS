import 'server-only';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { assert, DomainError } from '../errors';
import { changeItemStatus, type Actor } from './items';
import { addAttachments, copyAttachment } from './attachments';
import { MAX_RECEIVE, parseSerials, STATE_LABEL } from '@/domain/warehouse';
import {
  BACK_TO_STOCK_STATES, planReceiveRows, readReceivePayload, type ReceiveRequestPayload, type ReceiveRowDecision, type RequestPhoto,
} from '@/domain/receive-request';
import { receiveGoods } from './purchasing';

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
export async function approveReceiveRequest(
  tx: Tx,
  actor: Actor,
  id: string,
  opts: {
    warehouseId: string;
    receiptId?: string | null;
    receiptNumber?: string | null;
    /** Poznati uređaji koje administrator preskače (ostaju gdje jesu). */
    skipReturning?: string[];
    /** Ispravljeni serijski brojevi (skenirani kod → upisani) — za slike naljepnica. */
    serialFix?: Record<string, string>;
    /** Novi redovi koje je administrator preskočio (za zapis u zahtjevu). */
    skippedNew?: number;
  },
) {
  const r = await pendingReceive(tx, actor, id);
  const w = await tx.warehouse.findFirst({ where: { id: opts.warehouseId, companyId: actor.companyId }, select: { id: true, name: true } });
  assert(w, 'Skladište ne postoji.');
  const skip = new Set(opts.skipReturning ?? []);
  const returning = r.p.returning.filter((x) => !skip.has(x));
  assert(opts.receiptId || !r.p.serials.length || (opts.skippedNew ?? 0) >= r.p.serials.length, 'Zahtjev sadrži nove serijske brojeve — zaprimite ih kroz „Provjeri i zaprimi".');
  assert(opts.receiptId || returning.length, 'Nema ničega za zaprimiti — ako roba nije stigla, zahtjev odbijte.');

  // poznati uređaji: preskaču se oni koji su u međuvremenu već na skladištu ili obrisani
  const back = returning.length
    ? await tx.item.findMany({ where: { companyId: actor.companyId, id: { in: returning }, state: { in: BACK_TO_STOCK_STATES } }, select: { id: true, serial: true } })
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
    const code = ph.code ? (opts.serialFix?.[ph.code] ?? ph.code) : null;
    const target = (ph.itemId && backIds.has(ph.itemId) ? ph.itemId : null) ?? (code ? bySerial.get(code.trim().toUpperCase()) : undefined);
    if (target) photos += await copyAttachment(tx, actor, ph.id, 'item', target, `Zaprimanje ${ph.code ?? ''}`.trim());
  }

  const skippedAll = (opts.skippedNew ?? 0) + (r.p.returning.length - returning.length);
  const summary = [
    opts.receiptNumber && `primka ${opts.receiptNumber} (${created.length} kom)`,
    back.length && `vraćeno na skladište ${back.length} kom`,
    skippedAll && `preskočeno ${skippedAll}`,
  ]
    .filter(Boolean)
    .join(', ');
  const upd = await tx.approvalRequest.updateMany({
    where: { id: r.id, status: 'PENDING' },
    data: { status: 'APPROVED', resolvedBy: actor.name, resolvedAt: new Date(), resolveNote: summary ? `Zaprimljeno: ${summary}` : null },
  });
  assert(upd.count === 1, 'Zahtjev je već riješen.');
  return { returned: back.length, created: created.length, photos, requestedBy: r.requestedBy, warehouse: w.name };
}

export interface ReceiveReviewInput {
  warehouseId: string;
  supplierId: string | null;
  /** Nabavna cijena po komadu za nove uređaje. */
  cost: number;
  importDate: string;
  supplierDocNumber: string | null;
  note: string | null;
  bookExpense: boolean;
  /** Odluka za svaki novi kod iz zahtjeva (model, ispravak serijskog, preskoči). */
  rows: ReceiveRowDecision[];
  /** Poznati uređaji koji se ne vraćaju na skladište. */
  skipReturning: string[];
}

/**
 * Odobravanje zahtjeva po retku (E9): za svaki novi kod administrator bira
 * model, po potrebi ispravlja serijski broj (usporedba sa slikom) ili redak
 * preskače. Novi uređaji nastaju jednom primkom (po modelu stavka), poznati se
 * vraćaju na skladište, zahtjev postaje odobren — sve u jednoj transakciji.
 */
export async function approveReceiveRows(tx: Tx, actor: Actor, id: string, input: ReceiveReviewInput) {
  const r = await pendingReceive(tx, actor, id);
  let plan: ReturnType<typeof planReceiveRows>;
  try {
    plan = planReceiveRows(r.p.serials, input.rows);
  } catch (e) {
    throw new DomainError(e instanceof Error ? e.message : String(e));
  }
  assert(input.cost >= 0, 'Nabavna cijena ne može biti negativna.');
  const skipReturning = input.skipReturning.filter((x) => r.p.returning.includes(x));
  const returning = r.p.returning.length - skipReturning.length;
  assert(plan.received || returning, 'Svi redovi su preskočeni — ako roba nije stigla, zahtjev odbijte.');

  let receipt: { id: string; number: string; count: number } | null = null;
  if (plan.received) {
    receipt = await receiveGoods(tx, actor, {
      supplierId: input.supplierId,
      warehouseId: input.warehouseId,
      date: input.importDate,
      supplierDocNumber: input.supplierDocNumber,
      note: input.note ?? `Zahtjev za zaprimanje (${r.requestedBy})`,
      bookExpense: input.bookExpense,
      lines: [...plan.byModel].map(([modelId, serials]) => ({ modelId, unitCost: input.cost, serials })),
    });
  }
  const res = await approveReceiveRequest(tx, actor, id, {
    warehouseId: input.warehouseId,
    receiptId: receipt?.id ?? null,
    receiptNumber: receipt?.number ?? null,
    skipReturning,
    serialFix: plan.serialFix,
    skippedNew: plan.skipped,
  });
  return { ...res, receiptId: receipt?.id ?? null, receiptNumber: receipt?.number ?? null, skipped: plan.skipped + skipReturning.length };
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
