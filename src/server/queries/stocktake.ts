import 'server-only';
import { Prisma } from '@prisma/client';
import { db, type Tx } from '../db';
import { classifyScan, itemIdFromLink, scanCandidates, serialLabel, stocktakeCounts, type StocktakeCounts, type StocktakeKind } from '@/domain/warehouse';
import { escapeLike } from '@/lib/like';

// ---------------------------------------------------------------- skeniranje: kod → uređaj

export const scanItemSelect = {
  id: true,
  serial: true,
  dupNote: true,
  state: true,
  warehouseId: true,
  cost: true,
  model: { select: { brand: true, name: true } },
  status: { select: { id: true, name: true, color: true, kind: true } },
  warehouse: { select: { id: true, name: true } },
  partner: { select: { id: true, name: true } },
  contractItem: { select: { contract: { select: { id: true, number: true } } } },
} satisfies Prisma.ItemSelect;

export type ScanItem = Prisma.ItemGetPayload<{ select: typeof scanItemSelect }>;

/** Kako je kod uparen: točno, preko drugog oblika koda, poveznicom (QR) ili kao dio serijskog. */
export type ScanVia = 'exact' | 'variant' | 'link' | 'partial';

/**
 * Uređaji za pročitani kod. Redoslijed: poveznica iz QR-a naljepnice → točan
 * serijski (svi duplikati s razlikovnom napomenom) → drugi oblici koda (bez
 * prefiksa, GS1) → isto bez obzira na velika/mala slova → jednoznačan dio
 * serijskog (trigram indeks). Nikad ne čita cijelu tablicu.
 */
export async function findItemsByCode(client: Tx, companyId: string, code: string): Promise<{ items: ScanItem[]; via: ScanVia | null }> {
  const linkId = itemIdFromLink(code);
  if (linkId) {
    const it = await client.item.findFirst({ where: { id: linkId, companyId }, select: scanItemSelect });
    if (it) return { items: [it], via: 'link' };
  }
  const cands = scanCandidates(code);
  if (!cands.length) return { items: [], via: null };
  const order = [{ dupNote: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }] satisfies Prisma.ItemOrderByWithRelationInput[];

  const exact = await client.item.findMany({ where: { companyId, serial: { in: cands } }, select: scanItemSelect, orderBy: order, take: 50 });
  if (exact.length) {
    // prednost ima prvi oblik koda koji ima pogodak
    const first = cands.find((c) => exact.some((i) => i.serial === c))!;
    return { items: exact.filter((i) => i.serial === first), via: first === cands[0] ? 'exact' : 'variant' };
  }
  const insensitive = await client.item.findMany({
    where: { companyId, OR: cands.map((c) => ({ serial: { equals: c, mode: 'insensitive' as const } })) },
    select: scanItemSelect,
    orderBy: order,
    take: 50,
  });
  if (insensitive.length) return { items: insensitive, via: 'variant' };

  // dio serijskog: samo ako je jednoznačan (naljepnica sa skraćenim brojem)
  const main = cands[cands.length - 1];
  if (main.length >= 5) {
    const partial = await client.item.findMany({ where: { companyId, serial: { contains: escapeLike(main), mode: 'insensitive' } }, select: scanItemSelect, take: 2 });
    if (partial.length === 1) return { items: partial, via: 'partial' };
  }
  return { items: [], via: null };
}

/** Uređaji po id-u (osvježavanje popisa skeniranih nakon radnje). */
export function scanItemsByIds(companyId: string, ids: string[]) {
  if (!ids.length) return Promise.resolve([] as ScanItem[]);
  return db.item.findMany({ where: { companyId, id: { in: ids } }, select: scanItemSelect });
}

// ---------------------------------------------------------------- inventura

export async function listStocktakes(companyId: string, page: { skip: number; take: number }, status: 'OPEN' | 'CLOSED' | null) {
  const where: Prisma.StocktakeWhereInput = { companyId, ...(status ? { status } : {}) };
  const [rows, total] = await Promise.all([
    db.stocktake.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }],
      skip: page.skip,
      take: page.take,
      select: {
        id: true,
        number: true,
        status: true,
        note: true,
        createdBy: true,
        startedAt: true,
        closedAt: true,
        summary: true,
        warehouseId: true,
        warehouse: { select: { name: true } },
        _count: { select: { scans: true } },
      },
    }),
    db.stocktake.count({ where }),
  ]);
  return { rows, total };
}

export function getStocktake(companyId: string, id: string) {
  return db.stocktake.findFirst({ where: { id, companyId }, include: { warehouse: { select: { id: true, name: true, address: true } } } });
}

/** Uvjet „uređaj je očekivan u inventuri": na stanju, u skladištu inventure (ili bilo kojem). */
const expectedSql = (companyId: string, warehouseId: string | null, alias = 'i') => {
  const a = Prisma.raw(`"${alias}"`);
  return warehouseId
    ? Prisma.sql`${a}."companyId" = ${companyId} AND ${a}."state" = 'IN_STOCK' AND ${a}."warehouseId" = ${warehouseId}`
    : Prisma.sql`${a}."companyId" = ${companyId} AND ${a}."state" = 'IN_STOCK'`;
};

/** Brojači inventure iz trenutnih podataka (tri agregacije u bazi). */
export async function stocktakeLiveCounts(client: Tx, companyId: string, st: { id: string; warehouseId: string | null }) {
  const [row] = await client.$queryRaw<{ expected: bigint; scanned: bigint; found: bigint }[]>`
    SELECT
      (SELECT count(*) FROM "Item" i WHERE ${expectedSql(companyId, st.warehouseId)}) AS expected,
      (SELECT count(*) FROM "StocktakeScan" s WHERE s."stocktakeId" = ${st.id}) AS scanned,
      (SELECT count(*) FROM "StocktakeScan" s JOIN "Item" i ON i."id" = s."itemId"
        WHERE s."stocktakeId" = ${st.id} AND ${expectedSql(companyId, st.warehouseId)}) AS found`;
  return stocktakeCounts(Number(row.expected), Number(row.scanned), Number(row.found));
}

export interface StocktakeRow {
  scanId: string | null;
  serial: string;
  itemId: string | null;
  itemSerial: string | null;
  dupNote: string | null;
  model: string | null;
  state: string | null;
  statusName: string | null;
  statusColor: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  scannedAt: Date | null;
  scannedBy: string | null;
}

export type StocktakeTab = 'found' | 'missing' | 'extra';

/**
 * Popis za karticu inventure, straničen u bazi: pronađeni (skenirani i očekivani),
 * nedostaju (očekivani bez skena) ili višak (skenirani, a nisu očekivani).
 */
export async function stocktakeRows(
  companyId: string,
  st: { id: string; warehouseId: string | null },
  tab: StocktakeTab,
  page: { skip: number; take: number },
  client: Tx = db,
) {
  const exp = expectedSql(companyId, st.warehouseId);
  const cols = Prisma.sql`i."id" AS "itemId", i."serial" AS "itemSerial", i."dupNote", trim(concat_ws(' ', m."brand", m."name")) AS "model",
    i."state"::text AS "state", st."name" AS "statusName", st."color" AS "statusColor", i."warehouseId", w."name" AS "warehouseName"`;
  const joins = Prisma.sql`LEFT JOIN "DeviceModel" m ON m."id" = i."modelId" LEFT JOIN "ItemStatus" st ON st."id" = i."statusId" LEFT JOIN "Warehouse" w ON w."id" = i."warehouseId"`;
  if (tab === 'missing') {
    const rows = await client.$queryRaw<StocktakeRow[]>`
      SELECT NULL AS "scanId", i."serial" AS "serial", ${cols}, NULL::timestamp AS "scannedAt", NULL AS "scannedBy"
      FROM "Item" i ${joins}
      WHERE ${exp} AND NOT EXISTS (SELECT 1 FROM "StocktakeScan" s WHERE s."stocktakeId" = ${st.id} AND s."itemId" = i."id")
      ORDER BY i."serial", i."id" LIMIT ${page.take} OFFSET ${page.skip}`;
    return rows;
  }
  // IS TRUE / IS NOT TRUE: uređaj bez skladišta daje NULL u usporedbi, a mora pasti u višak
  const cond = tab === 'found' ? Prisma.sql`(i."id" IS NOT NULL AND ${exp}) IS TRUE` : Prisma.sql`(i."id" IS NOT NULL AND ${exp}) IS NOT TRUE`;
  return client.$queryRaw<StocktakeRow[]>`
    SELECT s."id" AS "scanId", s."serial", ${cols}, s."scannedAt", s."scannedBy"
    FROM "StocktakeScan" s LEFT JOIN "Item" i ON i."id" = s."itemId" AND i."companyId" = ${companyId} ${joins}
    WHERE s."stocktakeId" = ${st.id} AND ${cond}
    ORDER BY s."scannedAt" DESC, s."id" LIMIT ${page.take} OFFSET ${page.skip}`;
}

/** Id-evi uređaja koji nedostaju i uređaja na stanju iz drugog skladišta (za zatvaranje). */
export async function stocktakeCloseSets(client: Tx, companyId: string, st: { id: string; warehouseId: string | null }) {
  const exp = expectedSql(companyId, st.warehouseId);
  const [missing, wrongWarehouse] = await Promise.all([
    client.$queryRaw<{ id: string }[]>`
      SELECT i."id" FROM "Item" i
      WHERE ${exp} AND NOT EXISTS (SELECT 1 FROM "StocktakeScan" s WHERE s."stocktakeId" = ${st.id} AND s."itemId" = i."id")`,
    st.warehouseId
      ? client.$queryRaw<{ id: string }[]>`
          SELECT i."id" FROM "StocktakeScan" s JOIN "Item" i ON i."id" = s."itemId"
          WHERE s."stocktakeId" = ${st.id} AND i."companyId" = ${companyId} AND i."state" = 'IN_STOCK'
            AND i."warehouseId" IS DISTINCT FROM ${st.warehouseId}`
      : Promise.resolve([] as { id: string }[]),
  ]);
  return { missing: missing.map((r) => r.id), wrongWarehouse: wrongWarehouse.map((r) => r.id) };
}

/** Svi retci inventure za CSV i ispis (s gornjom granicom). */
export async function stocktakeAllRows(companyId: string, st: { id: string; warehouseId: string | null }, client: Tx = db) {
  const all = { skip: 0, take: 50_000 };
  const [found, missing, extra] = await Promise.all([
    stocktakeRows(companyId, st, 'found', all, client),
    stocktakeRows(companyId, st, 'missing', all, client),
    stocktakeRows(companyId, st, 'extra', all, client),
  ]);
  return { found, missing, extra };
}

/** Sažet redak za spremljeni izvještaj zatvorene inventure. */
export interface SnapRow {
  serial: string;
  itemId: string | null;
  model: string | null;
  status: string | null;
  warehouse: string | null;
  kind?: StocktakeKind;
  by?: string | null;
  at?: string | null;
}

export interface StocktakeSummary extends StocktakeCounts {
  unknown: number;
  wrongWarehouse: number;
  notInStock: number;
  rows: { found: SnapRow[]; missing: SnapRow[]; extra: SnapRow[] };
  actions: { transfers: string[]; moved: number; missingAction: string | null; missingChanged: number };
}

/** Uređaji iz viška po razlogu (za dijalog zatvaranja). */
export async function stocktakeBreakdown(companyId: string, st: { id: string; warehouseId: string | null }) {
  const rows = await stocktakeRows(companyId, st, 'extra', { skip: 0, take: 50_000 });
  const out: Record<StocktakeKind, number> = { found: 0, unknown: 0, wrongWarehouse: 0, notInStock: 0 };
  for (const r of rows) out[extraKind(r, st.warehouseId)]++;
  return out;
}

export const extraKind = (r: StocktakeRow, warehouseId: string | null) =>
  classifyScan(r.itemId ? { state: r.state ?? '', warehouseId: r.warehouseId } : null, warehouseId);

export const snapRow = (r: StocktakeRow, kind?: StocktakeKind): SnapRow => ({
  serial: r.itemSerial ? serialLabel(r.itemSerial, r.dupNote) : r.serial,
  itemId: r.itemId,
  model: r.model,
  status: r.statusName,
  warehouse: r.warehouseName,
  ...(kind ? { kind } : {}),
  ...(r.scannedAt ? { by: r.scannedBy, at: new Date(r.scannedAt).toISOString() } : {}),
});

/**
 * Sadržaj izvještaja: zatvorena inventura iz spremljenog sažetka (ne mijenja se
 * kad se stanje kasnije promijeni), otvorena iz trenutnih podataka.
 */
export async function stocktakeReport(
  companyId: string,
  st: { id: string; warehouseId: string | null; status: 'OPEN' | 'CLOSED'; summary: Prisma.JsonValue | null },
): Promise<{ counts: StocktakeCounts; found: SnapRow[]; missing: SnapRow[]; extra: SnapRow[]; actions: StocktakeSummary['actions'] | null }> {
  if (st.status === 'CLOSED' && st.summary) {
    const s = st.summary as unknown as StocktakeSummary;
    return { counts: stocktakeCounts(s.expected, s.scanned, s.found), ...s.rows, actions: s.actions };
  }
  const [counts, all] = await Promise.all([stocktakeLiveCounts(db, companyId, st), stocktakeAllRows(companyId, st)]);
  return {
    counts,
    found: all.found.map((r) => snapRow(r)),
    missing: all.missing.map((r) => snapRow(r)),
    extra: all.extra.map((r) => snapRow(r, extraKind(r, st.warehouseId))),
    actions: null,
  };
}
