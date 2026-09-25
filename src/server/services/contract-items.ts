import 'server-only';
import { Prisma, type Contract, type ContractItem, type ContractStatus, type ReturnedContractItem } from '@prisma/client';
import type { Tx } from '../db';
import { pendingInstallments, periodsInPause, type ContractDevice, type ContractTerms, type PlanPeriodInput } from '@/domain/billing';
import { addMonths, fromISO, periodLabel, toISO, today } from '@/domain/dates';
import { DomainError } from '../errors';
import { num } from '@/domain/money';

/**
 * Uređaji ugovora za motor naplate — bez ovisnosti o drugim servisima, pa ga
 * koriste i `items.ts` (skidanje s ugovora) i `rentals.ts`/`invoices.ts`.
 */

/** Ugovor iz baze → uvjeti za motor naplate. */
export function toTerms(c: Contract): ContractTerms {
  return {
    status: c.status,
    startDate: toISO(c.startDate),
    endDate: c.endDate ? toISO(c.endDate) : null,
    firstBillingDate: c.firstBillingDate ? toISO(c.firstBillingDate) : null,
    billingDay: c.billingDay,
    billing: c.billing,
    billingMode: c.billingMode,
    seasonFrom: c.seasonFrom,
    seasonTo: c.seasonTo,
    closedAt: c.closedAt ? toISO(c.closedAt) : null,
    pausedSince: c.pausedSince ? toISO(c.pausedSince) : null,
  };
}

export function toDevice(ci: ContractItem): ContractDevice {
  return {
    itemId: ci.itemId,
    monthly: num(ci.monthly),
    plan: (ci.plan as unknown as PlanPeriodInput[]) ?? [],
    status: ci.status,
    skipped: ci.skipped,
    paused: ci.paused,
    pausedSince: ci.pausedSince ? toISO(ci.pausedSince) : null,
  };
}

/** Uređaj skinut s ugovora: isti uvjeti, naplata do datuma skidanja. */
export function toReturnedDevice(r: ReturnedContractItem): ContractDevice {
  return {
    itemId: r.itemId,
    monthly: num(r.monthly),
    plan: (r.plan as unknown as PlanPeriodInput[]) ?? [],
    status: null,
    skipped: r.skipped,
    paused: r.paused,
    endDate: toISO(r.endDate),
  };
}

/**
 * Što je već fakturirano po ugovoru: ključevi `itemId|YYYY-MM` iz izdanih,
 * nestorniranih računa za najam — za zadane ugovore ili sve ugovore firme.
 * `since` (YYYY-MM) ograničava na razdoblja od tog mjeseca (motor naplate gleda
 * samo prozor unatrag).
 */
export async function coveredPeriods(tx: Tx, scope: string[] | { companyId: string }, opts: { since?: string } = {}): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (Array.isArray(scope) && !scope.length) return out;
  // razdoblje stavke: razdoblje računa, bez njega mjesec datuma računa
  const period = Prisma.sql`COALESCE(NULLIF(v.period, ''), to_char(v.date, 'YYYY-MM'))`;
  const lines = await tx.$queryRaw<{ contractId: string; itemId: string; period: string }[]>`
    SELECT DISTINCT v."contractId", l."itemId", ${period} AS period
    FROM "Invoice" v JOIN "InvoiceLine" l ON l."invoiceId" = v.id
    WHERE ${Array.isArray(scope) ? Prisma.sql`v."contractId" = ANY(${scope})` : Prisma.sql`v."companyId" = ${scope.companyId} AND v."contractId" IS NOT NULL`}
      AND v.status = 'ISSUED' AND v.kind = 'INVOICE' AND NOT v.stornoed
      AND l."itemId" IS NOT NULL
      -- stavka najma: na računu za najam (osim prodajnih stavki) ili stavka najma na miješanom računu
      AND (l."lineType" = 'RENT' OR (l."lineType" IS NULL AND v.type = 'RENT'))
      ${opts.since ? Prisma.sql`AND ${period} COLLATE "C" >= ${opts.since}` : Prisma.empty}`;
  for (const l of lines) {
    let set = out.get(l.contractId);
    if (!set) out.set(l.contractId, (set = new Set()));
    set.add(`${l.itemId}|${l.period}`);
  }
  return out;
}

/**
 * Stvarno fakturirani iznosi najma (neto stavki izdanih, nestorniranih računa) po
 * `itemId|YYYY-MM` u godini — raspored i pregled najma fakturirana razdoblja
 * prikazuju iz računa, ne iz današnjih uvjeta (cijena ili plan se mogu promijeniti).
 * Opseg: zadani ugovori ili uređaji firme (`itemIds`).
 */
export async function invoicedAmounts(tx: Tx, scope: { contractIds: string[] } | { companyId: string; itemIds: string[] }, year: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if ('contractIds' in scope ? !scope.contractIds.length : !scope.itemIds.length) return out;
  const period = Prisma.sql`COALESCE(NULLIF(v.period, ''), to_char(v.date, 'YYYY-MM'))`;
  const rows = await tx.$queryRaw<{ itemId: string; period: string; amount: number }[]>`
    SELECT l."itemId", ${period} AS period, SUM(l."netAmount")::float8 AS amount
    FROM "Invoice" v JOIN "InvoiceLine" l ON l."invoiceId" = v.id
    WHERE ${'contractIds' in scope ? Prisma.sql`v."contractId" = ANY(${scope.contractIds})` : Prisma.sql`v."companyId" = ${scope.companyId} AND v."contractId" IS NOT NULL AND l."itemId" = ANY(${scope.itemIds})`}
      AND v.status = 'ISSUED' AND v.kind = 'INVOICE' AND NOT v.stornoed
      AND l."itemId" IS NOT NULL
      AND (l."lineType" = 'RENT' OR (l."lineType" IS NULL AND v.type = 'RENT'))
      AND ${period} COLLATE "C" >= ${`${year}-01`} AND ${period} COLLATE "C" <= ${`${year}-12`}
    GROUP BY l."itemId", ${period}`;
  for (const r of rows) out.set(`${r.itemId}|${r.period}`, Number(r.amount));
  return out;
}

/**
 * Uređaji na ugovorima firme za motor naplate, samo sa stupcima koje motor treba.
 * Preskočena i pauzirana razdoblja skraćuju se na razdoblja od `since` — i to
 * jednom po skupini jednakih nizova (uvezeni ugovori imaju duge, iste nizove),
 * pa se ne prenose stotine tisuća starih razdoblja.
 */
export async function billingItems(tx: Tx, companyId: string, since: string, contractId?: string) {
  const scope = Prisma.sql`FROM "ContractItem" ci JOIN "Contract" c ON c.id = ci."contractId"
    WHERE c."companyId" = ${companyId} ${contractId ? Prisma.sql`AND c.id = ${contractId}` : Prisma.empty}`;
  const trim = (col: Prisma.Sql) => Prisma.sql`array_to_string(ARRAY(SELECT s FROM unnest(${col}) s WHERE s COLLATE "C" >= ${since}), ',')`;
  // Jedan upit (isti snimak baze), rezultat kao dva teksta: desetci tisuća redaka kroz Prismu
  // koštaju višestruko više od raščlanjivanja teksta. Redak uređaja: ugovor, uređaj, cijena, plan
  // (jsonb::text nema tabulatora ni novih redaka), status, početak pauze; skupina: uređaji, preskočena, pauzirana.
  const [row] = await tx.$queryRaw<Array<{ items: string | null; groups: string | null }>>`
    SELECT
      (SELECT string_agg(concat_ws(E'\t', ci."contractId", ci."itemId", ci.monthly::text, ci.plan::text,
          COALESCE(ci.status::text, ''), COALESCE(to_char(ci."pausedSince", 'YYYY-MM-DD'), '')), E'\n') ${scope}) AS items,
      (SELECT string_agg(concat_ws(E'\t', g.ids, g.skipped, g.paused), E'\n') FROM (
        SELECT string_agg(ci."itemId", ',') AS ids, ${trim(Prisma.sql`ci.skipped`)} AS skipped, ${trim(Prisma.sql`ci.paused`)} AS paused
        ${scope} GROUP BY ci.skipped, ci.paused) g) AS groups`;
  const split = (v: string) => (v ? v.split(',') : []);
  const groups = new Map<string, { skipped: string[]; paused: string[] }>();
  for (const line of row?.groups?.split('\n') ?? []) {
    const [ids, skipped, paused] = line.split('\t');
    const g = { skipped: split(skipped), paused: split(paused) };
    for (const id of ids.split(',')) groups.set(id, g);
  }
  const out: Array<{ contractId: string; device: ContractDevice }> = [];
  for (const line of row?.items?.split('\n') ?? []) {
    const [cid, itemId, monthly, plan, status, pausedSince] = line.split('\t');
    const g = groups.get(itemId)!;
    out.push({
      contractId: cid,
      device: {
        itemId,
        monthly: Number(monthly),
        plan: plan === '[]' ? [] : ((JSON.parse(plan) as PlanPeriodInput[] | null) ?? []),
        status: (status || null) as ContractStatus | null,
        skipped: g.skipped,
        paused: g.paused,
        pausedSince: pausedSince || null,
      },
    });
  }
  return out;
}

/**
 * Uređaj se vraća na isti ugovor (povrat iz servisa ili zamjenski uređaj na
 * njegovo mjesto): snimke skidanja s tog ugovora od `since` se brišu, a njihova
 * preskočena i pauzirana razdoblja prelaze u novi redak — naplata se nastavlja
 * na jednom retku i svako razdoblje se traži samo jednom.
 */
export async function takeBackReturned(tx: Tx, contractId: string, itemId: string, since: Date) {
  const from = fromISO(toISO(since));
  const rows = await tx.returnedContractItem.findMany({ where: { contractId, itemId, endDate: { gte: from } } });
  if (rows.length) await tx.returnedContractItem.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  return { skipped: rows.flatMap((r) => r.skipped), paused: rows.flatMap((r) => r.paused) };
}

const merge = (...lists: Array<string[] | null | undefined>) => [...new Set(lists.flatMap((l) => l ?? []))].sort();
export { merge as mergePeriods };

export interface PauseRow {
  id: string;
  /** Redak iz `ReturnedContractItem` (uređaj skinut s ugovora). */
  returned: boolean;
  device: ContractDevice;
  /** Početak pauze (YYYY-MM-DD). */
  since: string;
}

/**
 * Kraj pauze: rate dospjele u pauzi [since, until) upisuju se u pauzirana
 * razdoblja uređaja, osim već fakturiranih i preskočenih. Vraća broj upisanih.
 */
export async function addPausedPeriods(tx: Tx, c: Contract, rows: PauseRow[], until: string) {
  if (!rows.length) return 0;
  const covered = (await coveredPeriods(tx, [c.id])).get(c.id) ?? new Set<string>();
  const terms = toTerms(c);
  let n = 0;
  for (const r of rows) {
    const have = new Set([...(r.device.paused ?? []), ...(r.device.skipped ?? [])]);
    const add = periodsInPause(terms, r.device, r.since, until).filter((p) => !have.has(p) && !covered.has(`${r.device.itemId}|${p}`));
    if (!add.length) continue;
    const paused = [...(r.device.paused ?? []), ...add].sort();
    if (r.returned) await tx.returnedContractItem.update({ where: { id: r.id }, data: { paused } });
    else await tx.contractItem.update({ where: { id: r.id }, data: { paused } });
    n += add.length;
  }
  return n;
}

/**
 * Uređaj se skida s ugovora (povrat na skladište, prodaja, servis…): uvjeti se
 * čuvaju u `ReturnedContractItem` s datumom skidanja, pa rate do tog dana koje
 * još nisu izdane ostaju u „Rate za izdati". Pauza uređaja se zaključuje do tog dana.
 */
export async function keepReturned(tx: Tx, rows: ContractItem[], endDate: string) {
  if (!rows.length) return;
  const contracts = await tx.contract.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.contractId))] } } });
  const byId = new Map(contracts.map((c) => [c.id, c]));
  const covered = await coveredPeriods(tx, contracts.map((c) => c.id));
  const data: Prisma.ReturnedContractItemCreateManyInput[] = [];
  for (const ci of rows) {
    const c = byId.get(ci.contractId);
    if (!c) continue;
    // zatvoreni uvezeni ugovor ne traži rate; raskinut uređaj ili stara pauza bez početka — također ne
    if ((c.status === 'TERMINATED' || c.status === 'EXPIRED') && !c.closedAt) continue;
    if (ci.status === 'TERMINATED' || (ci.status === 'PAUSED' && !ci.pausedSince)) continue;
    const d = toDevice(ci);
    let paused = ci.paused;
    if (ci.status === 'PAUSED' && ci.pausedSince) {
      const have = new Set([...ci.paused, ...ci.skipped]);
      const cov = covered.get(c.id) ?? new Set<string>();
      const add = periodsInPause(toTerms(c), d, toISO(ci.pausedSince), endDate).filter((p) => !have.has(p) && !cov.has(`${ci.itemId}|${p}`));
      paused = [...paused, ...add].sort();
    }
    data.push({
      contractId: ci.contractId,
      itemId: ci.itemId,
      monthly: ci.monthly,
      plan: ci.plan as Prisma.InputJsonValue,
      skipped: ci.skipped,
      paused,
      endDate: fromISO(endDate),
    });
  }
  if (data.length) await tx.returnedContractItem.createMany({ data });
}

/**
 * Razdoblje koje račun za najam pokriva. Pokrivenost se vodi po `uređaj|razdoblje`
 * s jednim razdobljem računa (Invoice.period), pa svaki uređaj s računa mora u tom
 * razdoblju imati još nefakturiranu ratu s istim brojem mjeseci kao na stavci —
 * inače bi modul Najam istu ratu tražio ponovno (dvostruka naplata) ili bi rata
 * ostala krivo označena kao izdana. Bez odabranog razdoblja uzima se najranija
 * nefakturirana rata uređaja s računa; bez uređaja mjesec računa.
 */
export async function rentPeriodFor(
  tx: Tx,
  contractId: string,
  devLines: Array<{ itemId: string | null; months: number | null; description: string }>,
  chosen: string | null,
  date: string,
): Promise<string> {
  if (!devLines.length) return chosen ?? date.slice(0, 7);
  const ids = devLines.map((l) => l.itemId!);
  const [c, items] = await Promise.all([
    tx.contract.findUniqueOrThrow({
      where: { id: contractId },
      include: { items: { where: { itemId: { in: ids } } }, returnedItems: { where: { itemId: { in: ids } } } },
    }),
    tx.item.findMany({ where: { id: { in: ids } }, select: { id: true, serial: true } }),
  ]);
  const serial = new Map(items.map((i) => [i.id, i.serial]));
  const covered = (await coveredPeriods(tx, [contractId])).get(contractId) ?? new Set<string>();
  // sve rate do godinu dana nakon računa (ili odabranog razdoblja), bez ograničenja unatrag
  const base = [date, today(), chosen ? `${chosen}-28` : ''].reduce((a, b) => (b > a ? b : a));
  const rows = pendingInstallments({ ...toTerms(c), status: 'ACTIVE' }, [...c.items.map(toDevice), ...c.returnedItems.map(toReturnedDevice)], covered, addMonths(base, 12), 1200);
  const byItem = new Map<string, Map<string, { months: number }>>();
  for (const r of rows) for (const l of r.lines) {
    if (!byItem.has(l.itemId)) byItem.set(l.itemId, new Map());
    byItem.get(l.itemId)!.set(r.period, { months: l.months });
  }
  const firstOf = (itemId: string) => [...(byItem.get(itemId)?.keys() ?? [])].sort()[0] ?? null;
  const firsts = ids.map(firstOf).filter((p): p is string => !!p).sort();
  const period = chosen ?? firsts[0] ?? date.slice(0, 7);

  const bad: string[] = [];
  for (const l of devLines) {
    const sn = serial.get(l.itemId!) ?? l.description;
    const ch = byItem.get(l.itemId!)?.get(period);
    if (!ch) {
      const next = firstOf(l.itemId!);
      if (covered.has(`${l.itemId}|${period}`)) bad.push(`${sn} — ${periodLabel(period)} je već fakturiran`);
      else bad.push(`${sn} — ${next ? `prva nefakturirana rata je ${periodLabel(next)}` : 'nema nefakturiranih rata'}`);
    } else if (l.months !== null && l.months !== ch.months) {
      bad.push(`${sn} — rata za ${periodLabel(period)} pokriva ${ch.months} mj., a stavka ${l.months} mj.`);
    }
  }
  if (bad.length) {
    throw new DomainError(
      `Račun za najam pokriva razdoblje ${periodLabel(period)}, a to ne odgovara svim uređajima: ${bad.join('; ')}. ` +
        'Odaberite drugo razdoblje ili uređaje s različitim razdobljima naplate izdajte na zasebnim računima.',
    );
  }
  return period;
}
