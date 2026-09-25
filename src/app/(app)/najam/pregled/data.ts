import 'server-only';
import { Prisma, type ContractStatus } from '@prisma/client';
import { db } from '@/server/db';
import { toTerms } from '@/server/services/rentals';
import { devicePlan, deviceChargesInYear, type ContractDevice, type PlanPeriodInput } from '@/domain/billing';
import { today, toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { parseMulti } from '@/lib/list-params';

type Params = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v.trim() : '');

export interface OverviewFilters {
  year: number;
  partner: string;
  model: string;
  category: string;
  q: string;
  billedOnly: boolean;
  sold: boolean;
  excluded: boolean;
  /** Statusi uređaja (id-evi) — višestruki odabir. */
  statuses: string[];
  /** Vrsta retka: najam (uređaj na ugovoru) i/ili prodaja (bez ugovora). Prazno = sve. */
  kinds: Array<'najam' | 'prodaja'>;
}

export function readFilters(params: Params): OverviewFilters {
  const cy = Number(today().slice(0, 4));
  const y = Number(str(params.godina));
  return {
    year: y >= 2000 && y <= 2100 ? y : cy,
    partner: str(params.partner),
    model: str(params.model),
    category: str(params.kategorija),
    q: str(params.q),
    billedOnly: str(params.naplata) === '1',
    sold: str(params.prodani) === '1',
    excluded: str(params.iskljuceni) === '1',
    statuses: parseMulti(params, 'status'),
    kinds: parseMulti(params, 'vrsta', ['najam', 'prodaja'] as const),
  };
}

/** Uređaj na ugovoru — samo stupci za izračun (bez preskočenih razdoblja: ne utječu na rate u pregledu, a znaju biti duga). */
interface RowContractItem {
  contractId: string;
  itemId: string;
  monthly: number;
  plan: unknown;
  status: ContractStatus | null;
  paused: string[];
}

/**
 * Redci mreže, filtrirani i poredani u bazi: uređaji na ugovoru koji se
 * preklapa s godinom, uređaji s ručnim upisom u godini i (po želji) uređaji
 * prodani u godini. Vraća id-eve redom i, u istom upitu, stupce uređaja na
 * ugovoru za izračun (lako i za desetke tisuća redaka).
 */
async function rowIds(companyId: string, f: OverviewFilters): Promise<{ ids: string[]; cis: RowContractItem[] }> {
  const yStart = `${f.year}-01-01`;
  const yEnd = `${f.year}-12-31`;
  const t = today();
  const cutoff = t < yEnd && t >= yStart ? t : yEnd;
  const base = Prisma.sql`to_char(COALESCE(c."firstBillingDate", c."startDate"), 'YYYY-MM-DD')`;
  // „samo s naplatom": naplata (prvo razdoblje plana) je počela do danas / kraja godine i uređaj nije pauziran
  const billed = f.billedOnly
    ? Prisma.sql`AND COALESCE(ci.status, c.status) IN ('ACTIVE', 'EXPIRED')
        AND COALESCE(
          (SELECT MIN(COALESCE(NULLIF(e->>'from', ''), ${base}))
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ci.plan) = 'array' THEN ci.plan ELSE '[]'::jsonb END) e),
          ${base}) <= ${cutoff}`
    : Prisma.empty;
  // samo najam: redak s ugovorom; samo prodaja: bez ugovora (prodani u godini se tada uključuju sami)
  const onlyRent = f.kinds.length === 1 && f.kinds[0] === 'najam';
  const onlySale = f.kinds.length === 1 && f.kinds[0] === 'prodaja';
  const sold = f.sold || onlySale
    ? // nekorelirani podupit: skup prodanih uređaja se gradi jednom (ne po retku uređaja)
      Prisma.sql`OR i.id IN (
        SELECT l."itemId" FROM "InvoiceLine" l JOIN "Invoice" v ON v.id = l."invoiceId"
        WHERE l."itemId" IS NOT NULL AND v."companyId" = ${companyId} AND v.status = 'ISSUED' AND v.kind = 'INVOICE'
          AND v.type = 'SALE' AND NOT v.stornoed AND v.year = ${f.year})`
    : Prisma.empty;
  const q = f.q ? `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : '';
  const rows = await db.$queryRaw<Array<{ id: string } & Omit<RowContractItem, 'contractId' | 'itemId'> & { contractId: string | null }>>`
    SELECT i.id, ci."contractId", ci.monthly::float8 AS monthly, ci.plan, ci.status, ci.paused
    FROM "Item" i
    JOIN "DeviceModel" m ON m.id = i."modelId"
    LEFT JOIN "ContractItem" ci ON ci."itemId" = i.id
    LEFT JOIN "Contract" c ON c.id = ci."contractId"
    LEFT JOIN "Partner" p ON p.id = COALESCE(c."partnerId", i."partnerId")
    WHERE i."companyId" = ${companyId}
      AND (
        (c.id IS NOT NULL AND c."startDate" <= ${yEnd}::date AND (c."endDate" IS NULL OR c."endDate" >= ${yStart}::date) ${billed})
        OR EXISTS (SELECT 1 FROM "RentOverride" r WHERE r."itemId" = i.id AND r.year = ${f.year})
        ${sold}
      )
      ${f.excluded ? Prisma.empty : Prisma.sql`AND (p.id IS NULL OR NOT p.excluded)`}
      ${f.partner ? Prisma.sql`AND p.id = ${f.partner}` : Prisma.empty}
      ${f.model ? Prisma.sql`AND m.id = ${f.model}` : Prisma.empty}
      ${f.category ? Prisma.sql`AND m."categoryId" = ${f.category}` : Prisma.empty}
      ${f.statuses.length ? Prisma.sql`AND i."statusId" = ANY(${f.statuses})` : Prisma.empty}
      ${onlyRent ? Prisma.sql`AND c.id IS NOT NULL` : onlySale ? Prisma.sql`AND c.id IS NULL` : Prisma.empty}
      ${q ? Prisma.sql`AND (i.serial ILIKE ${q} OR m.name ILIKE ${q} OR COALESCE(m.brand, '') ILIKE ${q} OR COALESCE(p.name, '') ILIKE ${q})` : Prisma.empty}
    ORDER BY p.name NULLS LAST, i.serial, i.id`;
  const cis: RowContractItem[] = [];
  for (const r of rows) {
    if (r.contractId) cis.push({ contractId: r.contractId, itemId: r.id, monthly: r.monthly, plan: r.plan, status: r.status, paused: r.paused });
  }
  return { ids: rows.map((r) => r.id), cis };
}

export interface Cell {
  /** Prikazana vrijednost (null = prazno). */
  v: number | null;
  /** Ručni upis. */
  manual: boolean;
  /** Izračunata vrijednost (i za buduće mjesece) — za „planirano". */
  auto: number;
}

/**
 * Vrijednosti ćelija za zadane uređaje: ručni upis > rata s ugovora u mjesecu
 * > prodaja u mjesecu računa. Budući mjeseci prazni osim ručnog upisa.
 */
async function cellsFor(companyId: string, ids: string[], cis: RowContractItem[], f: OverviewFilters) {
  const now = today();
  const cy = Number(now.slice(0, 4));
  const lastShown = f.year < cy ? 11 : f.year > cy ? -1 : Number(now.slice(5, 7)) - 1;
  const contractIds = [...new Set(cis.map((c) => c.contractId))];
  const [overrides, sales, contracts] = await Promise.all([
    // id-evi idu kao jedan parametar polja (`= ANY`) — `in` s desecima tisuća id-eva prelazi granicu parametara
    ids.length
      ? db.$queryRaw<{ itemId: string; month: number; amount: Prisma.Decimal }[]>`
          SELECT r."itemId", r.month, r.amount FROM "RentOverride" r
          WHERE r."companyId" = ${companyId} AND r.year = ${f.year} AND r."itemId" = ANY(${ids})`
      : Promise.resolve([]),
    ids.length && (f.sold || (f.kinds.length === 1 && f.kinds[0] === 'prodaja'))
      ? db.$queryRaw<{ itemId: string; netAmount: Prisma.Decimal; date: Date }[]>`
          SELECT l."itemId", l."netAmount", v.date FROM "InvoiceLine" l JOIN "Invoice" v ON v.id = l."invoiceId"
          WHERE l."itemId" IS NOT NULL AND v."companyId" = ${companyId} AND v.status = 'ISSUED' AND v.kind = 'INVOICE'
            AND v.type = 'SALE' AND NOT v.stornoed AND v.year = ${f.year}`.then((rows) => {
            // sve prodaje firme u godini (jedan prolaz po indeksu računa), pa samo uređaji iz redaka
            const inRows = new Set(ids);
            return rows.filter((r) => inRows.has(r.itemId));
          })
      : Promise.resolve([]),
    // uvjeti ugovora jednom po ugovoru (vrlo mnogo ugovora: svi ugovori firme, unutar granice parametara)
    contractIds.length
      ? db.contract.findMany({ where: contractIds.length > 10_000 ? { companyId } : { companyId, id: { in: contractIds } } })
      : Promise.resolve([]),
  ]);
  const out = new Map<string, { cells: Cell[]; monthly: number; from: string | null }>();
  const get = (id: string) => {
    let r = out.get(id);
    if (!r) {
      r = { cells: Array.from({ length: 12 }, () => ({ v: null, manual: false, auto: 0 })), monthly: 0, from: null };
      out.set(id, r);
    }
    return r;
  };
  for (const s of sales) {
    const m = Number(toISO(s.date).slice(5, 7)) - 1;
    get(s.itemId).cells[m].auto = r2(get(s.itemId).cells[m].auto + num(s.netAmount));
  }
  const termsOf = new Map(contracts.map((c) => [c.id, toTerms(c)]));
  // uređaji istog ugovora s istom cijenom i planom daju iste rate — računaju se jednom
  const memo = new Map<string, { first: string | null; charges: { m: number; amount: number }[] }>();
  for (const ci of cis) {
    const terms = termsOf.get(ci.contractId);
    if (!terms) continue;
    const d: ContractDevice = { itemId: ci.itemId, monthly: ci.monthly, plan: (ci.plan as PlanPeriodInput[] | null) ?? [], status: ci.status, paused: ci.paused };
    const r = get(ci.itemId);
    r.monthly = d.monthly;
    const key = `${ci.contractId}|${d.monthly}|${d.status ?? ''}|${JSON.stringify(d.plan)}|${(d.paused ?? []).join(',')}`;
    let calc = memo.get(key);
    if (!calc) {
      calc = {
        first: devicePlan(terms, d)[0]?.from ?? null,
        charges: deviceChargesInYear(terms, d, f.year).map((ch) => ({ m: Number(ch.period.slice(5, 7)) - 1, amount: ch.amount })),
      };
      memo.set(key, calc);
    }
    if (calc.first && calc.first > now) r.from = calc.first;
    // rata je već zaokružena — zbrajanje (i zaokruživanje) samo kad ćelija već ima iznos
    for (const ch of calc.charges) {
      const c = r.cells[ch.m];
      c.auto = c.auto ? r2(c.auto + ch.amount) : ch.amount;
    }
  }
  for (const id of ids) {
    const cells = get(id).cells;
    for (let m = 0; m < 12; m++) cells[m].v = m <= lastShown && cells[m].auto ? cells[m].auto : null;
  }
  for (const o of overrides) {
    const c = get(o.itemId).cells[o.month - 1];
    c.v = num(o.amount);
    c.manual = true;
    c.auto = num(o.amount);
  }
  return { map: out, lastShown };
}

export interface OverviewRow {
  itemId: string;
  serial: string;
  partner: string | null;
  model: string;
  category: string | null;
  status: { name: string; color: string };
  contract: { id: string; number: string } | null;
  monthly: number;
  from: string | null;
  cells: Cell[];
  total: number;
}

export interface OverviewTotals {
  devices: number;
  monthly: number;
  months: number[];
  collected: number;
  planned: number;
}

/** Stranica mreže (ili sve za izvoz): redci s ćelijama i zbrojevi za cijeli filtar. */
export async function loadOverview(companyId: string, f: OverviewFilters, page: { skip: number; take: number } | null) {
  const { ids: all, cis } = await rowIds(companyId, f);
  const pageIds = page ? all.slice(page.skip, page.skip + page.take) : all;

  // zbrojevi za sve filtrirane retke — motor naplate treba plan svakog uređaja
  const { map, lastShown } = await cellsFor(companyId, all, cis, f);
  const totals: OverviewTotals = { devices: all.length, monthly: 0, months: Array(12).fill(0), collected: 0, planned: 0 };
  for (const r of map.values()) {
    totals.monthly += r.monthly;
    for (let m = 0; m < 12; m++) {
      const c = r.cells[m];
      if (c.v) totals.months[m] += c.v;
      if (m <= lastShown) totals.collected += c.v ?? 0;
      else totals.planned += c.manual ? (c.v ?? 0) : c.auto;
    }
  }
  totals.monthly = r2(totals.monthly);
  totals.months = totals.months.map(r2);
  totals.collected = r2(totals.collected);
  totals.planned = r2(totals.planned);

  const items = await db.item.findMany({
    where: { id: { in: pageIds }, companyId },
    select: {
      id: true, serial: true,
      status: { select: { name: true, color: true } },
      partner: { select: { name: true } },
      model: { select: { brand: true, name: true, category: { select: { name: true } } } },
      contractItem: { select: { contract: { select: { id: true, number: true, partner: { select: { name: true } } } } } },
    },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows: OverviewRow[] = pageIds.flatMap((id) => {
    const i = byId.get(id);
    if (!i) return [];
    const r = map.get(id)!;
    const c = i.contractItem?.contract ?? null;
    return [{
      itemId: i.id,
      serial: i.serial,
      partner: c?.partner.name ?? i.partner?.name ?? null,
      model: [i.model.brand, i.model.name].filter(Boolean).join(' '),
      category: i.model.category?.name ?? null,
      status: i.status,
      contract: c ? { id: c.id, number: c.number } : null,
      monthly: r.monthly,
      from: r.from,
      cells: r.cells,
      total: r2(r.cells.reduce((a, x) => a + (x.v ?? 0), 0)),
    }];
  });
  return { rows, totals, total: all.length, lastShown };
}
