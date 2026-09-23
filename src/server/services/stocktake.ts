import 'server-only';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { assert } from '../errors';
import { nextDocNumber } from '../numbering';
import type { Actor } from './items';
import { applyStatusChange, transferItems, writeOff } from './warehouse';
import {
  extraKind, findItemsByCode, snapRow, stocktakeAllRows, stocktakeCloseSets, stocktakeLiveCounts, type ScanItem, type StocktakeSummary,
} from '../queries/stocktake';
import { today } from '@/domain/dates';
import { classifyScan, scanCandidates, serialLabel, type StocktakeCounts, type StocktakeKind } from '@/domain/warehouse';

/*
 * Inventura: popis stanja skeniranjem. Očekivani uređaji računaju se iz
 * trenutnih podataka (na stanju u skladištu inventure), skenovi se spremaju
 * po serijskom broju (jedinstveno po inventuri), pa više ljudi može skenirati
 * istu inventuru istovremeno — dvostruki sken istog broja je bezopasan.
 */

async function loadOpen(tx: Tx, actor: Actor, id: string) {
  const st = await tx.stocktake.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, number: true, status: true, warehouseId: true } });
  assert(st, 'Inventura ne postoji.');
  assert(st.status === 'OPEN', `Inventura ${st.number} je zatvorena.`);
  return st;
}

export async function createStocktake(tx: Tx, actor: Actor, input: { warehouseId: string | null; note: string | null }) {
  if (input.warehouseId) {
    const w = await tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: actor.companyId }, select: { id: true } });
    assert(w, 'Skladište ne postoji.');
  }
  const number = await nextDocNumber(tx, actor.companyId, 'STOCKTAKE', Number(today().slice(0, 4)));
  return tx.stocktake.create({
    data: { companyId: actor.companyId, number, warehouseId: input.warehouseId, note: input.note, createdBy: actor.name },
    select: { id: true, number: true },
  });
}

export interface ScanOutcome {
  result: 'added' | 'duplicate' | 'choose';
  serial: string;
  kind: StocktakeKind | null;
  scanId: string | null;
  item: ScanItem | null;
  /** Više uređaja s istim serijskim — korisnik bira koji je skeniran. */
  variants: ScanItem[];
  counts: StocktakeCounts;
}

/** Jedan sken u inventuri. `itemId` = izbor među duplikatima serijskog. */
export async function scanStocktake(tx: Tx, actor: Actor, input: { stocktakeId: string; code: string; itemId?: string | null }): Promise<ScanOutcome> {
  const st = await loadOpen(tx, actor, input.stocktakeId);
  const code = scanCandidates(input.code)[0];
  assert(code, 'Prazan kod.');

  const { items } = await findItemsByCode(tx, actor.companyId, input.code);
  let item: ScanItem | null = null;
  if (input.itemId) {
    item = items.find((i) => i.id === input.itemId) ?? null;
    assert(item, 'Odabrani uređaj ne odgovara skeniranom kodu.');
  } else if (items.length === 1) {
    item = items[0];
  } else if (items.length > 1) {
    // duplikati serijskog: ako je samo jedan očekivan i još nije skeniran, to je on
    const scanned = new Set(
      (await tx.stocktakeScan.findMany({ where: { stocktakeId: st.id, itemId: { in: items.map((i) => i.id) } }, select: { itemId: true } })).map((s) => s.itemId),
    );
    const open = items.filter((i) => !scanned.has(i.id));
    const expected = open.filter((i) => classifyScan(i, st.warehouseId) === 'found');
    if (expected.length === 1) item = expected[0];
    else if (open.length === 1) item = open[0];
    else if (!open.length) item = items[0];
    else {
      return { result: 'choose', serial: items[0].serial, kind: null, scanId: null, item: null, variants: open, counts: await stocktakeLiveCounts(tx, actor.companyId, st) };
    }
  }

  const serial = item ? serialLabel(item.serial, item.dupNote) : code;
  // jedinstveno (inventura, serijski): istovremeni sken istog broja ne ruši ni jedan zahtjev
  const ins = await tx.stocktakeScan.createMany({
    data: [{ stocktakeId: st.id, serial, itemId: item?.id ?? null, scannedBy: actor.name }],
    skipDuplicates: true,
  });
  const scan = await tx.stocktakeScan.findUnique({ where: { stocktakeId_serial: { stocktakeId: st.id, serial } }, select: { id: true } });
  return {
    result: ins.count ? 'added' : 'duplicate',
    serial,
    kind: classifyScan(item, st.warehouseId),
    scanId: scan?.id ?? null,
    item,
    variants: [],
    counts: await stocktakeLiveCounts(tx, actor.companyId, st),
  };
}

/** Poništenje skena (npr. „vrati zadnji"). */
export async function removeScan(tx: Tx, actor: Actor, input: { stocktakeId: string; scanId: string }) {
  const st = await loadOpen(tx, actor, input.stocktakeId);
  const del = await tx.stocktakeScan.deleteMany({ where: { id: input.scanId, stocktakeId: st.id } });
  return { removed: del.count, counts: await stocktakeLiveCounts(tx, actor.companyId, st) };
}

export interface CloseInput {
  id: string;
  /** Uređaje na stanju iz drugog skladišta premjesti u skladište inventure (međuskladišnica). */
  moveWrongWarehouse: boolean;
  /** Što s uređajima koji nedostaju: ništa, status po id-u ili otpis. */
  missing: { kind: 'none' } | { kind: 'status'; statusId: string } | { kind: 'writeOff'; bookExpense: boolean };
}

/**
 * Zatvaranje: sažetak i popisi se spremaju (izvještaj ostaje isti i kad se stanje
 * kasnije promijeni), pa po želji premještaj „zalutalih" i status nedostajućih —
 * obje radnje kroz postojeće servise (međuskladišnica, changeItemStatus / otpis).
 */
export async function closeStocktake(tx: Tx, actor: Actor, input: CloseInput) {
  const st = await loadOpen(tx, actor, input.id);
  const counts = await stocktakeLiveCounts(tx, actor.companyId, st);
  const all = await stocktakeAllRows(actor.companyId, st, tx);
  const extra = all.extra.map((r) => snapRow(r, extraKind(r, st.warehouseId)));
  const by = (k: StocktakeKind) => extra.filter((r) => r.kind === k).length;
  const sets = await stocktakeCloseSets(tx, actor.companyId, st);

  const actions: StocktakeSummary['actions'] = { transfers: [], moved: 0, missingAction: null, missingChanged: 0 };
  if (input.moveWrongWarehouse && st.warehouseId && sets.wrongWarehouse.length) {
    const r = await transferItems(tx, actor, { itemIds: sets.wrongWarehouse, toWarehouseId: st.warehouseId, note: `Inventura ${st.number}` });
    actions.transfers = r.numbers;
    actions.moved = r.count;
  }
  if (input.missing.kind !== 'none' && sets.missing.length) {
    if (input.missing.kind === 'writeOff') {
      const r = await writeOff(tx, actor, {
        itemIds: sets.missing,
        reason: 'Izgubljen',
        note: `Inventura ${st.number} — nije pronađen`,
        bookExpense: input.missing.bookExpense,
        date: today(),
      });
      actions.missingAction = 'Otpis (izgubljen)';
      actions.missingChanged = r.count;
    } else {
      const status = await tx.itemStatus.findFirst({ where: { id: input.missing.statusId, companyId: actor.companyId }, select: { name: true, kind: true } });
      assert(status, 'Status ne postoji.');
      assert(status.kind !== 'IN_STOCK', 'Nedostajući uređaji ne mogu dobiti status „na skladištu".');
      const r = await applyStatusChange(tx, actor, { itemIds: sets.missing, statusId: input.missing.statusId, note: null }, `inventura ${st.number} — nije pronađen`);
      actions.missingAction = status.name;
      actions.missingChanged = r.count;
    }
  }

  const summary: StocktakeSummary = {
    ...counts,
    unknown: by('unknown'),
    wrongWarehouse: by('wrongWarehouse'),
    notInStock: by('notInStock'),
    rows: { found: all.found.map((r) => snapRow(r)), missing: all.missing.map((r) => snapRow(r)), extra },
    actions,
  };
  // uvjet na OPEN štiti od dvostrukog zatvaranja
  const upd = await tx.stocktake.updateMany({
    where: { id: st.id, status: 'OPEN' },
    data: { status: 'CLOSED', closedAt: new Date(), summary: summary as unknown as Prisma.InputJsonValue },
  });
  assert(upd.count === 1, 'Inventura je već zatvorena.');
  return { number: st.number, summary };
}

/** Brisanje otvorene inventure (pogrešno pokrenuta). Zatvorena ostaje kao dokument. */
export async function deleteStocktake(tx: Tx, actor: Actor, id: string) {
  const st = await loadOpen(tx, actor, id);
  await tx.stocktake.delete({ where: { id: st.id } });
  return { number: st.number };
}
