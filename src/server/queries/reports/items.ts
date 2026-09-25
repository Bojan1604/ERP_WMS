import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { reportSql } from './sql';
import { suggestedSalePrice } from '@/domain/pricing';
import { num } from '@/domain/money';
import {
  inIds, iso, itemFilterSql, monthChart, monthRows, n, periodSql, r2, revenueLinesSql, type ReportDef, type ReportFilters, type Row,
} from './types';

/**
 * Izvještaji po komadima, klijentu i modelu (prijenos r6, r14, r18, r26, r27,
 * r28, r30 iz starog programa). Sve se zbraja u bazi (GROUP BY), pa i uz
 * stotine tisuća uređaja i računa izvještaj ostaje brz.
 */

/** Kategorija stavke: po komadu (uređaj), inače modela. Traži aliase it (LEFT JOIN Item … AND it."categoryId" IS NOT NULL — spaja se samo komad s vlastitom kategorijom) i m. */
const lineCatSql = (f: ReportFilters) => (f.categoryIds.length ? Prisma.sql`AND COALESCE(it."categoryId", m."categoryId") IN (${Prisma.join(f.categoryIds)})` : Prisma.empty);
/** Uređaj na ugovoru se naplaćuje ako nema vlastitog statusa ili je aktivan. */
const billable = Prisma.sql`(ci."status" IS NULL OR ci."status" = 'ACTIVE')`;
const OPEN_SERVICE = Prisma.sql`('REPORTED','RECEIVED','DIAGNOSIS','AT_SUPPLIER')`;
const wantSale = (f: ReportFilters) => !f.types.length || f.types.includes('SALE');
const wantRent = (f: ReportFilters) => !f.types.length || f.types.includes('RENT');

export const itemReports: ReportDef[] = [
  {
    slug: 'prosjecna-prodajna-cijena',
    title: 'Prosječna prodajna cijena',
    area: 'Prodaja',
    description: 'Prosječna nabavna i prodajna cijena po modelu, s odstupanjem od preporučene prodajne cijene.',
    filters: ['year', 'range', 'partner', 'category', 'model'],
    requiresCost: true,
    run: async (companyId, f) => {
      // cijena stavke nakon popusta na račun, umanjena za odobrenja (besplatni uređaji ne ulaze u prosjek)
      const where = Prisma.sql`(l."isCredit" OR l.net > 0) ${inIds('m.id', f.modelIds)} ${lineCatSql(f)}`;
      const from = Prisma.sql`FROM (${revenueLinesSql(companyId, f, { lineType: 'SALE', deviceOnly: true })}) l JOIN "DeviceModel" m ON m.id = l."modelId" LEFT JOIN "Item" it ON it.id = l."itemId" AND it."categoryId" IS NOT NULL`;
      const avg = Prisma.sql`SUM(l.qty)::int AS qty, (SUM(l."cost") / NULLIF(SUM(l.qty), 0))::float8 AS "avgCost", (SUM(l.net) / NULLIF(SUM(l.qty), 0))::float8 AS "avgPrice"`;
      const [rows, months, company] = await Promise.all([
        reportSql<Array<{ id: string; model: string; qty: number; avgCost: number; avgPrice: number; salePrice: Prisma.Decimal | null; marginPct: Prisma.Decimal | null }>>`
          SELECT m.id, concat_ws(' ', m.brand, m.name) AS model, ${avg}, m."salePrice", m."marginPct"
          ${from} WHERE ${where}
          GROUP BY m.id HAVING SUM(l.qty) > 0 ORDER BY model`,
        reportSql<Array<{ m: number; qty: number; avgCost: number; avgPrice: number }>>`
          SELECT EXTRACT(MONTH FROM l."date")::int AS m, ${avg}
          ${from} WHERE ${where} GROUP BY 1 HAVING SUM(l.qty) > 0`,
        db.company.findUniqueOrThrow({ where: { id: companyId }, select: { defaultMarginPct: true } }),
      ]);
      const out: Row[] = rows.map((r) => {
        const sug = suggestedSalePrice({ modelPrice: r.salePrice ? num(r.salePrice) : null, cost: r.avgCost, modelMargin: r.marginPct ? num(r.marginPct) : null, companyMargin: num(company.defaultMarginPct) }).price;
        return {
          model: r.model, qty: r.qty, avgCost: r2(r.avgCost), avgPrice: r2(r.avgPrice), suggested: sug, diff: r2(r.avgPrice - sug),
          diffPct: sug ? ((r.avgPrice - sug) / sug) * 100 : null, _muted: r.avgPrice < sug ? 'bad' : null,
        };
      });
      const chartRows = monthRows(f.year, (m) => {
        const x = months.find((r) => r.m === m);
        return { avgPrice: x ? r2(x.avgPrice) : 0, avgCost: x ? r2(x.avgCost) : 0 };
      });
      return {
        columns: [
          { key: 'model', label: 'Model' },
          { key: 'qty', label: 'Kom.', kind: 'int' },
          { key: 'avgCost', label: 'Prosj. nabavna', kind: 'money', sum: false, cost: true },
          { key: 'avgPrice', label: 'Prosj. prodajna', kind: 'money', sum: false },
          { key: 'suggested', label: 'Preporučena', kind: 'money', sum: false },
          { key: 'diff', label: 'Odstupanje', kind: 'money', sum: false },
          { key: 'diffPct', label: 'Odstupanje %', kind: 'pct', sum: false },
        ],
        rows: out,
        chart: monthChart(f.year, chartRows, [{ key: 'avgPrice', label: 'Prosj. prodajna' }, { key: 'avgCost', label: 'Prosj. nabavna' }], { stacked: false }),
        chartCost: true,
        note: 'Preporučena cijena: prodajna cijena modela, a bez nje nabavna uvećana za maržu modela (ili zadanu maržu firme). Crveno = prodano ispod preporučene.',
      };
    },
  },
  {
    slug: 'uredaji-po-komadima',
    title: 'Uređaji po komadima',
    area: 'Prodaja',
    description: 'Koliko je komada kojeg modela prodano ili dano u najam, uz prihod prodaje i mjesečni najam.',
    filters: ['year', 'range', 'type', 'partner', 'category', 'model', 'status', 'warehouse', 'supplier'],
    run: async (companyId, f) => {
      // prodajna cijena komada: nakon popusta na račun, umanjena za odobrenja; komad je prodan u razdoblju ako je račun u njemu
      const soldCte = Prisma.sql`SELECT l."itemId", SUM(l.net) AS price, MAX(l."date") FILTER (WHERE NOT l."isCredit") AS d
        FROM (${revenueLinesSql(companyId, f, { lineType: 'SALE', deviceOnly: true, withItem: true })}) l
        /* vrsta (prodaja), uređaj i komad su suženi u revenueLinesSql */
        GROUP BY l."itemId" HAVING bool_or(NOT l."isCredit")`;
      const rentCte = Prisma.sql`SELECT ci."itemId", ci."monthly", ci."addedAt"
        FROM "ContractItem" ci JOIN "Contract" c ON c.id = ci."contractId" JOIN "Partner" p ON p.id = c."partnerId"
        WHERE c."companyId" = ${companyId} AND c."status" = 'ACTIVE' AND ${billable} AND p."excluded" = false ${inIds('c."partnerId"', f.partnerIds)}`;
      // u izvještaju su prodani i iznajmljeni uređaji; uz filtar statusa i svi uređaji tog statusa
      const context = [
        wantSale(f) ? Prisma.sql`s."itemId" IS NOT NULL` : null,
        wantRent(f) ? Prisma.sql`r."itemId" IS NOT NULL` : null,
        f.statusIds.length ? Prisma.sql`(TRUE ${inIds('it."partnerId"', f.partnerIds)})` : null,
      ].filter((x): x is Prisma.Sql => !!x);
      // bez filtra statusa u izvještaj ulaze samo prodani/iznajmljeni komadi — suzi uređaje odmah (isti uvjet, ali prije spajanja 300k uređaja)
      const only = f.statusIds.length
        ? Prisma.empty
        : Prisma.sql`AND it.id IN (${Prisma.join(
            [wantSale(f) ? Prisma.sql`SELECT "itemId" FROM s` : null, wantRent(f) ? Prisma.sql`SELECT "itemId" FROM r` : null].filter((x): x is Prisma.Sql => !!x),
            ' UNION ',
          )})`;
      const [rows, chart] = await Promise.all([
        reportSql<Array<{ id: string; model: string; category: string | null; total: number; sold: number; rented: number; revenue: Prisma.Decimal; monthly: Prisma.Decimal }>>`
          WITH s AS (${soldCte}), r AS (${rentCte})
          SELECT m.id, concat_ws(' ', m.brand, m.name) AS model, cat.name AS category, COUNT(*)::int AS total,
                 COUNT(s."itemId") FILTER (WHERE s.price > 0)::int AS sold, COUNT(r."itemId")::int AS rented,
                 COALESCE(SUM(s.price) FILTER (WHERE s.price > 0), 0) AS revenue, COALESCE(SUM(r."monthly"), 0) AS monthly
          FROM "Item" it
          JOIN "DeviceModel" m ON m.id = it."modelId"
          LEFT JOIN "Category" cat ON cat.id = m."categoryId"
          LEFT JOIN s ON s."itemId" = it.id
          LEFT JOIN r ON r."itemId" = it.id
          WHERE it."companyId" = ${companyId} AND (${Prisma.join(context, ' OR ')}) ${only} ${itemFilterSql(f, { partner: false })}
          GROUP BY m.id, cat.name ORDER BY total DESC, model`,
        reportSql<Array<{ m: number; sold: number; rented: number }>>`
          WITH s AS (${soldCte}), r AS (${rentCte})
          SELECT x.m, SUM(x.sold)::int AS sold, SUM(x.rented)::int AS rented FROM (
            SELECT EXTRACT(MONTH FROM s.d)::int AS m, 1 AS sold, 0 AS rented FROM s JOIN "Item" it ON it.id = s."itemId" JOIN "DeviceModel" m ON m.id = it."modelId"
              WHERE ${wantSale(f)}::boolean AND s.price > 0 ${itemFilterSql(f, { partner: false })}
            UNION ALL
            SELECT EXTRACT(MONTH FROM r."addedAt")::int, 0, 1 FROM r JOIN "Item" it ON it.id = r."itemId" JOIN "DeviceModel" m ON m.id = it."modelId"
              WHERE ${wantRent(f)}::boolean ${periodSql('r."addedAt"::date', f)} ${itemFilterSql(f, { partner: false })}
          ) x GROUP BY 1`,
      ]);
      const out: Row[] = rows.map((r) => ({
        model: r.model, category: r.category, total: r.total, sold: r.sold, rented: r.rented, revenue: n(r.revenue),
        avgPrice: r.sold ? r2(n(r.revenue) / r.sold) : null, monthly: n(r.monthly) || null,
      }));
      const chartRows = monthRows(f.year, (m) => {
        const x = chart.find((c) => c.m === m);
        return { sold: x?.sold ?? 0, rented: x?.rented ?? 0 };
      });
      return {
        columns: [
          { key: 'model', label: 'Model' },
          { key: 'category', label: 'Kategorija' },
          { key: 'total', label: 'Komada', kind: 'int' },
          { key: 'sold', label: 'Prodano', kind: 'int' },
          { key: 'rented', label: 'U najmu', kind: 'int' },
          { key: 'revenue', label: 'Prihod prodaje', kind: 'money' },
          { key: 'avgPrice', label: 'Prosj. cijena', kind: 'money', sum: false },
          { key: 'monthly', label: 'Mjesečni najam', kind: 'money' },
        ],
        rows: out,
        chart: monthChart(f.year, chartRows, [{ key: 'sold', label: 'Prodano' }, { key: 'rented', label: 'Dano u najam' }], { stacked: true, unit: 'int' }),
        note: 'Prodano = uređaji na važećim računima prodaje u razdoblju; u najmu = uređaji na aktivnim ugovorima (u grafu po datumu dodavanja na ugovor).',
      };
    },
  },
  {
    slug: 'prihod-klijent-model',
    title: 'Prihod po klijentu i modelu',
    area: 'Prodaja',
    description: 'Tko je što kupio i za koliko — svaki red je kombinacija klijenta i modela; usluge i ručne stavke su u zasebnim redovima.',
    filters: ['year', 'range', 'partner', 'category', 'model'],
    run: async (companyId, f) => {
      // kao „Prihod po mjesecima" → Prodaja: računi vrste prodaja (cijeli račun, i usluge i ručne stavke),
      // stavke nakon popusta na račun, storna i odobrenja umanjuju prihod — zbroj je jednak stupcu Prodaja
      // vrsta računa (prodaja) se provjerava unutar izvedene tablice — na računu, odnosno na odobrenju
      const from = Prisma.sql`FROM (${revenueLinesSql(companyId, f, { withStorno: true, docType: 'SALE' })}) l JOIN "Partner" p ON p.id = l."partnerId"
        LEFT JOIN "DeviceModel" m ON m.id = l."modelId" LEFT JOIN "Item" it ON it.id = l."itemId" AND it."categoryId" IS NOT NULL`;
      const where = Prisma.sql`TRUE ${inIds('m.id', f.modelIds)} ${lineCatSql(f)}`;
      // stavke bez modela: usluge iz šifrarnika i ručne (slobodne) stavke, svaka skupina u svom redu
      const other = Prisma.sql`CASE WHEN l."lineKind" = 'SERVICE' THEN 'Usluge' ELSE 'Ručne stavke' END`;
      const [rows, months] = await Promise.all([
        reportSql<Array<{ pid: string; partner: string; model: string; isModel: boolean; qty: number; revenue: Prisma.Decimal; last: Date }>>`
          SELECT p.id AS pid, p.name AS partner, COALESCE(MAX(concat_ws(' ', m.brand, m.name)) FILTER (WHERE m.id IS NOT NULL), MAX(${other})) AS model,
                 bool_or(m.id IS NOT NULL) AS "isModel", SUM(l.qty)::int AS qty, SUM(l.net) AS revenue,
                 MAX(l."date") FILTER (WHERE l."docKind" = 'INVOICE') AS last
          ${from} WHERE ${where}
          GROUP BY p.id, COALESCE(m.id, ${other}) HAVING SUM(l.qty) <> 0 OR ABS(SUM(l.net)) >= 0.005 ORDER BY revenue DESC, partner, model`,
        reportSql<Array<{ m: number; qty: number; revenue: Prisma.Decimal }>>`
          SELECT EXTRACT(MONTH FROM l."date")::int AS m, SUM(l.qty)::int AS qty, SUM(l.net) AS revenue ${from} WHERE ${where} GROUP BY 1`,
      ]);
      const out: Row[] = rows.map((r) => ({
        partner: r.partner, model: r.model, qty: r.qty, revenue: r2(n(r.revenue)), avgPrice: r.isModel && r.qty > 0 ? r2(n(r.revenue) / r.qty) : null, last: r.last ? iso(r.last) : null, _href: `/partneri/${r.pid}`,
      }));
      const chartRows = monthRows(f.year, (m) => ({ revenue: n(months.find((x) => x.m === m)?.revenue) }));
      return {
        columns: [
          { key: 'partner', label: 'Klijent' },
          { key: 'model', label: 'Model' },
          { key: 'qty', label: 'Komada', kind: 'int' },
          { key: 'revenue', label: 'Prihod', kind: 'money' },
          { key: 'avgPrice', label: 'Prosj. cijena', kind: 'money', sum: false },
          { key: 'last', label: 'Zadnja prodaja', kind: 'date' },
        ],
        rows: out,
        chart: monthChart(f.year, chartRows, [{ key: 'revenue', label: 'Prihod' }]),
        note: 'Prihod je nakon popusta na račun; storna i knjižna odobrenja ga umanjuju (odobrenje se raspoređuje na stavke izvornog računa). Uključene su usluge i ručne stavke (redovi „Usluge" i „Ručne stavke"), pa je zbroj jednak stupcu Prodaja u „Prihod po mjesecima".',
      };
    },
  },
  {
    slug: 'najam-klijent-model',
    title: 'Prihod od najma po klijentu i modelu',
    area: 'Najam',
    description: 'Mjesečni najam na aktivnim ugovorima i fakturirani najam u razdoblju, razloženo po klijentu i modelu, uz kretanje kroz godinu.',
    filters: ['year', 'range', 'partner', 'category', 'model'],
    run: async (companyId, f) => {
      // fakturirano: stavke najma nakon popusta na račun, storna i odobrenja umanjuju (kao „Prihod po mjesecima")
      const invFrom = Prisma.sql`FROM (${revenueLinesSql(companyId, f, { withStorno: true, lineType: 'RENT' })}) l
        LEFT JOIN "Item" it ON it.id = l."itemId" JOIN "DeviceModel" m ON m.id = COALESCE(l."modelId", it."modelId")`;
      const invWhere = Prisma.sql`TRUE ${inIds('m.id', f.modelIds)} ${lineCatSql(f)}`;
      const [rows, months] = await Promise.all([
        reportSql<Array<{ pid: string; partner: string; model: string; devices: number | null; monthly: Prisma.Decimal | null; billed: Prisma.Decimal | null }>>`
          WITH a AS (
            SELECT c."partnerId", it."modelId", COUNT(*)::int AS devices, SUM(ci."monthly") AS monthly
            FROM "ContractItem" ci JOIN "Contract" c ON c.id = ci."contractId" JOIN "Partner" p ON p.id = c."partnerId"
            JOIN "Item" it ON it.id = ci."itemId" JOIN "DeviceModel" m ON m.id = it."modelId"
            WHERE c."companyId" = ${companyId} AND c."status" = 'ACTIVE' AND ${billable} AND p."excluded" = false
              ${inIds('c."partnerId"', f.partnerIds)} ${itemFilterSql({ ...f, statusIds: [], warehouseIds: [], supplierIds: [] }, { partner: false })}
            GROUP BY 1, 2
          ), v AS (
            SELECT l."partnerId", m.id AS "modelId", SUM(l.net) AS billed ${invFrom} WHERE ${invWhere} GROUP BY 1, 2
          )
          SELECT pp.id AS pid, pp.name AS partner, concat_ws(' ', mm.brand, mm.name) AS model, a.devices, a.monthly, v.billed
          FROM a FULL OUTER JOIN v ON v."partnerId" = a."partnerId" AND v."modelId" = a."modelId"
          JOIN "Partner" pp ON pp.id = COALESCE(a."partnerId", v."partnerId")
          JOIN "DeviceModel" mm ON mm.id = COALESCE(a."modelId", v."modelId")
          ORDER BY a.monthly DESC NULLS LAST, v.billed DESC NULLS LAST, pp.name, model`,
        reportSql<Array<{ m: number; billed: Prisma.Decimal }>>`
          SELECT EXTRACT(MONTH FROM l."date")::int AS m, SUM(l.net) AS billed ${invFrom} WHERE ${invWhere} GROUP BY 1`,
      ]);
      const out: Row[] = rows.map((r) => ({
        partner: r.partner, model: r.model, devices: r.devices ?? 0, monthly: n(r.monthly), annual: r2(n(r.monthly) * 12), billed: n(r.billed), _href: `/partneri/${r.pid}?tab=ugovori`,
      }));
      const chartRows = monthRows(f.year, (m) => ({ billed: n(months.find((x) => x.m === m)?.billed) }));
      return {
        columns: [
          { key: 'partner', label: 'Klijent' },
          { key: 'model', label: 'Model' },
          { key: 'devices', label: 'Uređaja u najmu', kind: 'int' },
          { key: 'monthly', label: 'Mjesečno', kind: 'money' },
          { key: 'annual', label: 'Godišnje (×12)', kind: 'money' },
          { key: 'billed', label: `Fakturirano ${f.year ? `${f.year}.` : '(sve godine)'}`, kind: 'money' },
        ],
        rows: out,
        chart: monthChart(f.year, chartRows, [{ key: 'billed', label: 'Fakturirani najam' }]),
        note: 'Mjesečno = uređaji na aktivnim ugovorima (bez pauziranih i raskinutih). Fakturirano = stavke najma na računima u razdoblju nakon popusta na račun, umanjene za storna i odobrenja.',
      };
    },
  },
  {
    slug: 'najam-po-kategoriji',
    title: 'Količine u najmu po kategoriji',
    area: 'Najam',
    description: 'Koliko je komada kojeg tipa opreme trenutno u najmu — po kategoriji, s brojem modela, klijenata i mjesečnim iznosom.',
    filters: ['partner', 'category', 'model'],
    run: async (companyId, f) => {
      const itf = itemFilterSql({ ...f, statusIds: [], warehouseIds: [], supplierIds: [], partnerIds: [] }, { partner: false });
      // uređaji na aktivnim ugovorima + uređaji u statusu najma bez ugovora (status govori da su vani)
      const u = Prisma.sql`
        SELECT it.id, it."modelId", COALESCE(it."categoryId", m."categoryId") AS cat, c."partnerId", ci."monthly"
        FROM "ContractItem" ci JOIN "Contract" c ON c.id = ci."contractId" JOIN "Partner" p ON p.id = c."partnerId"
        JOIN "Item" it ON it.id = ci."itemId" JOIN "DeviceModel" m ON m.id = it."modelId"
        WHERE c."companyId" = ${companyId} AND c."status" = 'ACTIVE' AND ${billable} AND p."excluded" = false ${inIds('c."partnerId"', f.partnerIds)} ${itf}
        UNION ALL
        SELECT it.id, it."modelId", COALESCE(it."categoryId", m."categoryId"), it."partnerId", COALESCE(it."rentPrice", 0)
        FROM "Item" it JOIN "DeviceModel" m ON m.id = it."modelId" LEFT JOIN "Partner" hp ON hp.id = it."partnerId"
        WHERE it."companyId" = ${companyId} AND it."state" = 'RENTED' AND (hp.id IS NULL OR hp."excluded" = false)
          AND NOT EXISTS (SELECT 1 FROM "ContractItem" x WHERE x."itemId" = it.id) ${inIds('it."partnerId"', f.partnerIds)} ${itf}`;
      const [rows, byModel] = await Promise.all([
        reportSql<Array<{ category: string | null; cnt: number; models: number; partners: number; monthly: Prisma.Decimal }>>`
          WITH u AS (${u})
          SELECT cat.name AS category, COUNT(*)::int AS cnt, COUNT(DISTINCT u."modelId")::int AS models, COUNT(DISTINCT u."partnerId")::int AS partners,
                 COALESCE(SUM(u."monthly"), 0) AS monthly
          FROM u LEFT JOIN "Category" cat ON cat.id = u.cat
          GROUP BY cat.name ORDER BY cnt DESC`,
        reportSql<Array<{ model: string; cnt: number }>>`
          WITH u AS (${u})
          SELECT concat_ws(' ', m.brand, m.name) AS model, COUNT(*)::int AS cnt FROM u JOIN "DeviceModel" m ON m.id = u."modelId"
          GROUP BY m.id ORDER BY cnt DESC LIMIT 14`,
      ]);
      const out: Row[] = rows.map((r) => ({
        category: r.category ?? 'Bez kategorije', count: r.cnt, models: r.models, partners: r.partners, monthly: n(r.monthly), avg: r.cnt ? r2(n(r.monthly) / r.cnt) : null,
      }));
      const count = out.reduce((a, r) => a + Number(r.count), 0);
      const monthly = r2(out.reduce((a, r) => a + Number(r.monthly), 0));
      return {
        columns: [
          { key: 'category', label: 'Kategorija' },
          { key: 'count', label: 'Komada', kind: 'int' },
          { key: 'models', label: 'Različitih modela', kind: 'int', sum: false },
          { key: 'partners', label: 'Klijenata', kind: 'int', sum: false },
          { key: 'monthly', label: 'Mjesečno', kind: 'money' },
          { key: 'avg', label: 'Prosj. po komadu', kind: 'money', sum: false },
        ],
        rows: out,
        totals: out.length ? { count, monthly, avg: count ? r2(monthly / count) : null } : null,
        chart: { kind: 'hbar', title: 'Komada u najmu po modelu', unit: 'int', rows: byModel.map((r) => ({ label: r.model, value: r.cnt })) },
        note: 'Uključeni su uređaji na aktivnim ugovorima i uređaji u statusu najma bez ugovora (s cijenom najma s uređaja).',
      };
    },
  },
  {
    slug: 'uvoz-po-mjesecima',
    title: 'Uvoz po mjesecima',
    area: 'Nabava',
    description: 'Dinamika nabave — koliko je uređaja ušlo u skladište po mjesecu zaprimanja i po kojoj vrijednosti.',
    filters: ['year', 'range', 'category', 'model', 'status', 'warehouse', 'supplier'],
    run: async (companyId, f) => {
      const rows = await reportSql<Array<{ m: number; cnt: number; value: Prisma.Decimal; models: number }>>`
        SELECT EXTRACT(MONTH FROM it."importDate")::int AS m, COUNT(*)::int AS cnt, SUM(it."cost") AS value, COUNT(DISTINCT it."modelId")::int AS models
        FROM "Item" it JOIN "DeviceModel" m ON m.id = it."modelId"
        WHERE it."companyId" = ${companyId} AND it."importDate" IS NOT NULL ${periodSql('it."importDate"', f)} ${itemFilterSql(f, { partner: false })}
        GROUP BY 1`;
      const out = monthRows(f.year, (m) => {
        const r = rows.find((x) => x.m === m);
        return { count: r?.cnt ?? 0, models: r?.models ?? 0, value: n(r?.value), avg: r?.cnt ? r2(n(r.value) / r.cnt) : null };
      });
      return {
        columns: [
          { key: 'month', label: 'Mjesec' },
          { key: 'count', label: 'Komada', kind: 'int' },
          { key: 'models', label: 'Modela', kind: 'int', sum: false },
          { key: 'value', label: 'Vrijednost', kind: 'money', cost: true },
          { key: 'avg', label: 'Prosj. nabavna', kind: 'money', sum: false, cost: true },
        ],
        rows: out,
        chart: monthChart(f.year, out, [{ key: 'count', label: 'Uređaja' }], { unit: 'int' }),
        note: 'Po datumu zaprimanja (uvoza) uređaja.',
      };
    },
  },
  {
    slug: 'kvarovi-i-servis',
    title: 'Kvarovi i servis po modelu',
    area: 'Servis',
    description: 'Uređaji u kvaru, servisni/zamjenski i kod klijenta — udio po modelu u odnosu na sve uređaje modela.',
    filters: ['partner', 'category', 'model', 'warehouse', 'supplier'],
    run: async (companyId, f) => {
      const rows = await reportSql<Array<{ id: string; model: string; total: number; broken: number; other: number; atClient: number; brokenValue: Prisma.Decimal; open: number | null }>>`
        SELECT m.id, concat_ws(' ', m.brand, m.name) AS model, COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE it."state" = 'SERVICE')::int AS broken,
               COUNT(*) FILTER (WHERE it."state" = 'OTHER')::int AS other,
               COUNT(*) FILTER (WHERE it."partnerId" IS NOT NULL AND it."state" IN ('RENTED','OTHER','RESERVED'))::int AS "atClient",
               COALESCE(SUM(it."cost") FILTER (WHERE it."state" = 'SERVICE'), 0) AS "brokenValue",
               MAX(o.open)::int AS open
        FROM "Item" it
        JOIN "DeviceModel" m ON m.id = it."modelId"
        LEFT JOIN "Partner" hp ON hp.id = it."partnerId"
        LEFT JOIN (
          SELECT x."modelId", COUNT(*)::int AS open FROM "ServiceOrder" so JOIN "Item" x ON x.id = so."itemId"
          WHERE so."companyId" = ${companyId} AND so."status" IN ${OPEN_SERVICE} GROUP BY 1
        ) o ON o."modelId" = m.id
        WHERE it."companyId" = ${companyId} AND it."state" <> 'WRITTEN_OFF' AND (hp.id IS NULL OR hp."excluded" = false) ${itemFilterSql(f)}
        GROUP BY m.id
        HAVING COUNT(*) FILTER (WHERE it."state" IN ('SERVICE','OTHER')) > 0 OR MAX(o.open) > 0
        ORDER BY (COUNT(*) FILTER (WHERE it."state" = 'SERVICE'))::float8 / COUNT(*) DESC, model`;
      const out: Row[] = rows.map((r) => ({
        model: r.model, total: r.total, broken: r.broken, rate: r.total ? (r.broken / r.total) * 100 : null, other: r.other, atClient: r.atClient,
        open: r.open ?? 0, brokenValue: n(r.brokenValue), _muted: r.total && r.broken / r.total >= 0.1 ? 'bad' : null,
      }));
      return {
        columns: [
          { key: 'model', label: 'Model' },
          { key: 'total', label: 'Ukupno uređaja', kind: 'int' },
          { key: 'broken', label: 'U kvaru', kind: 'int' },
          { key: 'rate', label: 'Stopa kvara', kind: 'pct', sum: false },
          { key: 'other', label: 'Servisni / zamjenski / demo', kind: 'int' },
          { key: 'atClient', label: 'Kod klijenta', kind: 'int' },
          { key: 'open', label: 'Otvorenih naloga', kind: 'int' },
          { key: 'brokenValue', label: 'Vrijednost u kvaru', kind: 'money', cost: true },
        ],
        rows: out,
        chart: { kind: 'hbar', title: 'Stopa kvara po modelu (%)', unit: 'int', rows: out.filter((r) => Number(r.broken) > 0).slice(0, 12).map((r) => ({ label: String(r.model), value: Math.round(Number(r.rate) * 10) / 10 })) },
        note: 'U kvaru = uređaji statusa vrste „servis" (pokvaren). Servisni/zamjenski/demo = statusi vrste „ostalo". Otpisani uređaji nisu uključeni.',
      };
    },
  },
];
