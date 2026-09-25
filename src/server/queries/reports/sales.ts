import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { reportSql } from './sql';
import { expensesByMonth, revenueByMonth } from './costs';
import { inIds, itemFilterSql, margin, monthChart, monthRows, n, periodSql, r2, revenueLinesSql, revenueSql, typeSql, type ReportDef, type ReportFilters, type Row } from './types';

/** Kategorija stavke: po komadu (uređaj), inače modela. Traži aliase it (LEFT JOIN Item … AND it."categoryId" IS NOT NULL — spaja se samo komad s vlastitom kategorijom) i m. */
const lineCatSql = (f: ReportFilters) => (f.categoryIds.length ? Prisma.sql`AND COALESCE(it."categoryId", m."categoryId") IN (${Prisma.join(f.categoryIds)})` : Prisma.empty);

export const salesReports: ReportDef[] = [
  {
    slug: 'prihod-po-mjesecima',
    title: 'Prihod po mjesecima',
    area: 'Prodaja',
    description: 'Neto prihod iz izdanih računa (umanjen za storna i odobrenja), podijeljen na prodaju, najam i usluge.',
    filters: ['year', 'range', 'partner', 'type'],
    run: async (companyId, f) => {
      const rows = await reportSql<Array<{ m: number; type: string; net: Prisma.Decimal; cnt: number }>>`
        SELECT EXTRACT(MONTH FROM i."date")::int AS m, i."type"::text AS type, SUM(i."netTotal") AS net,
               COUNT(*) FILTER (WHERE i."kind" = 'INVOICE')::int AS cnt
        FROM "Invoice" i JOIN "Partner" p ON p.id = i."partnerId"
        WHERE ${revenueSql(companyId)} ${periodSql('i."date"', f)} ${inIds('i."partnerId"', f.partnerIds)} ${typeSql('i."type"', f)}
        GROUP BY 1, 2`;
      const out = monthRows(f.year, (m) => {
        const of = (t: string) => n(rows.find((r) => r.m === m && r.type === t)?.net);
        const sale = of('SALE');
        const rent = of('RENT');
        const service = of('SERVICE');
        return { sale, rent, service, total: r2(sale + rent + service), invoices: rows.filter((r) => r.m === m).reduce((a, r) => a + r.cnt, 0) };
      });
      const hasService = out.some((r) => r.service);
      return {
        columns: [
          { key: 'month', label: 'Mjesec' },
          { key: 'sale', label: 'Prodaja', kind: 'money' },
          { key: 'rent', label: 'Najam', kind: 'money' },
          { key: 'service', label: 'Usluge', kind: 'money' },
          { key: 'total', label: 'Ukupno', kind: 'money' },
          { key: 'invoices', label: 'Računa', kind: 'int' },
        ],
        rows: out,
        chart: monthChart(f.year, out, [{ key: 'sale', label: 'Prodaja' }, { key: 'rent', label: 'Najam' }, ...(hasService ? [{ key: 'service', label: 'Usluge' }] : [])], { stacked: true }),
      };
    },
  },
  {
    slug: 'profit-po-mjesecima',
    title: 'Profit po mjesecima',
    area: 'Prodaja',
    description: 'Prihod − nabavna vrijednost prodanog = bruto dobit; umanjena za troškove poslovanja daje profit.',
    filters: ['year'],
    singleYear: true,
    requiresCost: true,
    run: async (companyId, f) => {
      // nabava robe se ne oduzima dvaput: ulazi kroz nabavnu vrijednost prodanog
      const [rev, exp] = await Promise.all([revenueByMonth(companyId, f), expensesByMonth(companyId, f.displayYear, { excludePurchases: true })]);
      const rows = monthRows(f.year, (m) => {
        const r = rev.revenue[m - 1];
        const c = rev.cost[m - 1];
        const e = r2(exp.total[m - 1]);
        return { revenue: r, cost: c, gross: r2(r - c), margin: margin(r, c), expenses: e, profit: r2(r - c - e) };
      });
      const sum = (k: string) => r2(rows.reduce((a, x) => a + Number(x[k] ?? 0), 0));
      return {
        columns: [
          { key: 'month', label: 'Mjesec' },
          { key: 'revenue', label: 'Prihod', kind: 'money' },
          { key: 'cost', label: 'Nabavna vrij. prodanog', kind: 'money' },
          { key: 'gross', label: 'Bruto dobit', kind: 'money' },
          { key: 'margin', label: 'Bruto marža', kind: 'pct' },
          { key: 'expenses', label: 'Troškovi poslovanja', kind: 'money' },
          { key: 'profit', label: 'Profit', kind: 'money' },
        ],
        rows,
        totals: { revenue: sum('revenue'), cost: sum('cost'), gross: sum('gross'), margin: margin(sum('revenue'), sum('cost')), expenses: sum('expenses'), profit: sum('profit') },
        chart: monthChart(f.year, rows, [{ key: 'profit', label: 'Profit' }]),
        note: 'Troškovi poslovanja ne uključuju nabavu robe (ona je u nabavnoj vrijednosti prodanog). Iznosi su bez PDV-a.',
      };
    },
  },
  {
    slug: 'top-kupci',
    title: 'Top kupci',
    area: 'Prodaja',
    description: 'Kupci po neto prihodu u godini, s udjelom u ukupnom prihodu i otvorenim dugom.',
    filters: ['year', 'range', 'partner', 'type'],
    run: async (companyId, f) => {
      const rows = await reportSql<Array<{ id: string; name: string; city: string | null; net: Prisma.Decimal; sale: Prisma.Decimal; rent: Prisma.Decimal; service: Prisma.Decimal; cnt: number; share: number | null }>>`
        SELECT p.id, p.name, p.city, SUM(i."netTotal") AS net,
               SUM(i."netTotal") FILTER (WHERE i."type" = 'SALE') AS sale,
               SUM(i."netTotal") FILTER (WHERE i."type" = 'RENT') AS rent,
               SUM(i."netTotal") FILTER (WHERE i."type" = 'SERVICE') AS service,
               COUNT(*) FILTER (WHERE i."kind" = 'INVOICE')::int AS cnt,
               (SUM(i."netTotal") / NULLIF(SUM(SUM(i."netTotal")) OVER (), 0) * 100)::float8 AS share
        FROM "Invoice" i JOIN "Partner" p ON p.id = i."partnerId"
        WHERE ${revenueSql(companyId)} ${periodSql('i."date"', f)} ${inIds('i."partnerId"', f.partnerIds)} ${typeSql('i."type"', f)}
        GROUP BY p.id ORDER BY net DESC LIMIT 100`;
      const open = rows.length
        ? await db.invoice.groupBy({ by: ['partnerId'], where: { companyId, partnerId: { in: rows.map((r) => r.id) }, status: 'ISSUED', openAmount: { gt: 0 } }, _sum: { openAmount: true } })
        : [];
      const openBy = new Map(open.map((o) => [o.partnerId, n(o._sum.openAmount)]));
      const out: Row[] = rows.map((r, i) => ({
        rank: i + 1,
        name: r.name,
        city: r.city,
        invoices: r.cnt,
        sale: n(r.sale),
        rent: n(r.rent),
        service: n(r.service),
        net: n(r.net),
        share: r.share,
        open: openBy.get(r.id) ?? 0,
        _href: `/partneri/${r.id}`,
      }));
      return {
        columns: [
          { key: 'rank', label: '#', kind: 'int', sum: false },
          { key: 'name', label: 'Kupac' },
          { key: 'city', label: 'Mjesto' },
          { key: 'invoices', label: 'Računa', kind: 'int' },
          { key: 'sale', label: 'Prodaja', kind: 'money' },
          { key: 'rent', label: 'Najam', kind: 'money' },
          // računi usluge (vrsta SERVICE) — Prodaja + Najam + Usluge = Ukupno
          { key: 'service', label: 'Usluge', kind: 'money' },
          { key: 'net', label: 'Ukupno neto', kind: 'money' },
          { key: 'share', label: 'Udio', kind: 'pct', sum: true },
          { key: 'open', label: 'Otvoreno', kind: 'money' },
        ],
        rows: out,
        chart: { kind: 'hbar', title: 'Deset najvećih kupaca', rows: out.slice(0, 10).map((r) => ({ label: String(r.name), value: Number(r.net), href: r._href ?? undefined })) },
        note: rows.length === 100 ? 'Prikazano je 100 najvećih kupaca.' : undefined,
      };
    },
  },
  {
    slug: 'marza-po-modelu',
    title: 'Marža po modelu',
    area: 'Prodaja',
    description: 'Prodani uređaji po modelu: prihod iz stavki važećih računa prodaje, nabavna vrijednost i bruto marža.',
    filters: ['year', 'range', 'partner', 'category', 'model'],
    requiresCost: true,
    run: async (companyId, f) => {
      const rows = await reportSql<Array<{ id: string; model: string; category: string | null; qty: number; revenue: Prisma.Decimal; cost: Prisma.Decimal }>>`
        SELECT m.id, concat_ws(' ', m.brand, m.name) AS model, c.name AS category,
               SUM(l.qty)::int AS qty, SUM(l.net) AS revenue, SUM(l."cost") AS cost
        FROM (${revenueLinesSql(companyId, f, { lineType: 'SALE', deviceOnly: true })}) l
        JOIN "DeviceModel" m ON m.id = l."modelId"
        LEFT JOIN "Item" it ON it.id = l."itemId" AND it."categoryId" IS NOT NULL
        LEFT JOIN "Category" c ON c.id = m."categoryId"
        WHERE TRUE ${inIds('m.id', f.modelIds)} ${lineCatSql(f)}
        GROUP BY m.id, c.name HAVING SUM(l.qty) > 0
        ORDER BY SUM(l.net) - SUM(l."cost") DESC`;
      const out: Row[] = rows.map((r) => {
        const rev = n(r.revenue);
        const cost = n(r.cost);
        return { model: r.model, category: r.category, qty: r.qty, revenue: rev, cost, profit: r2(rev - cost), margin: margin(rev, cost), avgPrice: r2(rev / r.qty), avgCost: r2(cost / r.qty) };
      });
      const rev = out.reduce((a, r) => a + Number(r.revenue), 0);
      const cost = out.reduce((a, r) => a + Number(r.cost), 0);
      const qty = out.reduce((a, r) => a + Number(r.qty), 0);
      return {
        columns: [
          { key: 'model', label: 'Model' },
          { key: 'category', label: 'Kategorija' },
          { key: 'qty', label: 'Prodano', kind: 'int' },
          { key: 'revenue', label: 'Prihod', kind: 'money' },
          { key: 'cost', label: 'Nabavna', kind: 'money' },
          { key: 'profit', label: 'Bruto dobit', kind: 'money' },
          { key: 'margin', label: 'Marža', kind: 'pct' },
          { key: 'avgPrice', label: 'Prosj. prodajna', kind: 'money', sum: false },
          { key: 'avgCost', label: 'Prosj. nabavna', kind: 'money', sum: false },
        ],
        rows: out,
        totals: { qty, revenue: r2(rev), cost: r2(cost), profit: r2(rev - cost), margin: margin(rev, cost), avgPrice: qty ? r2(rev / qty) : null, avgCost: qty ? r2(cost / qty) : null },
        chart: { kind: 'hbar', title: 'Bruto dobit po modelu', rows: out.slice(0, 10).map((r) => ({ label: String(r.model), value: Number(r.profit) })) },
        note: 'Marža se računa samo na prodanim uređajima; najam, demo i otpis ne ulaze. Stornirani računi su isključeni; prihod je nakon popusta na račun i umanjen za odobrenja.',
      };
    },
  },
  {
    slug: 'prodaja-po-kategorijama',
    title: 'Prodaja po kategorijama',
    area: 'Prodaja',
    description: 'Stavke važećih računa prodaje po kategoriji modela, s maržom i udjelom u prodaji.',
    filters: ['year', 'range', 'partner', 'category', 'model'],
    run: async (companyId, f) => {
      const rows = await reportSql<Array<{ category: string; qty: Prisma.Decimal; revenue: Prisma.Decimal; cost: Prisma.Decimal }>>`
        SELECT COALESCE(c.name, CASE WHEN l."modelId" IS NULL THEN 'Usluge i ostale stavke' ELSE 'Bez kategorije' END) AS category,
               SUM(l."qty") AS qty, SUM(l.net) AS revenue, SUM(l."cost") AS cost
        FROM (${revenueLinesSql(companyId, f, { lineType: 'SALE' })}) l
        LEFT JOIN "Item" it ON it.id = l."itemId" AND it."categoryId" IS NOT NULL
        LEFT JOIN "DeviceModel" m ON m.id = l."modelId"
        LEFT JOIN "Category" c ON c.id = COALESCE(it."categoryId", m."categoryId")
        WHERE TRUE ${inIds('m.id', f.modelIds)} ${lineCatSql(f)}
        GROUP BY 1 ORDER BY revenue DESC`;
      const total = rows.reduce((a, r) => a + n(r.revenue), 0);
      const out: Row[] = rows.map((r) => {
        const rev = n(r.revenue);
        const cost = n(r.cost);
        return { category: r.category, qty: n(r.qty), revenue: rev, cost, profit: r2(rev - cost), margin: margin(rev, cost), share: total ? (rev / total) * 100 : null };
      });
      const cost = out.reduce((a, r) => a + Number(r.cost), 0);
      return {
        columns: [
          { key: 'category', label: 'Kategorija' },
          { key: 'qty', label: 'Količina', kind: 'int' },
          { key: 'revenue', label: 'Prihod', kind: 'money' },
          { key: 'cost', label: 'Nabavna', kind: 'money', cost: true },
          { key: 'profit', label: 'Bruto dobit', kind: 'money', cost: true },
          { key: 'margin', label: 'Marža', kind: 'pct', cost: true },
          { key: 'share', label: 'Udio', kind: 'pct', sum: true },
        ],
        rows: out,
        totals: { qty: out.reduce((a, r) => a + Number(r.qty), 0), revenue: r2(total), cost: r2(cost), profit: r2(total - cost), margin: margin(total, cost), share: total ? 100 : null },
        chart: { kind: 'hbar', title: 'Prihod po kategoriji', rows: out.map((r) => ({ label: String(r.category), value: Number(r.revenue) })) },
        note: 'Prihod stavki je nakon popusta na cijeli račun (raspoređen razmjerno) i umanjen za knjižna odobrenja; stornirani računi su isključeni.',
      };
    },
  },
  {
    slug: 'zarada-po-uredaju',
    title: 'Zarada po uređaju',
    area: 'Prodaja',
    description: 'Stavke važećih računa po uređaju (prodaja i rate najma) u razdoblju u odnosu na nabavnu cijenu — 200 najprofitabilnijih.',
    filters: ['year', 'range', 'partner', 'category', 'model', 'status', 'warehouse', 'supplier'],
    requiresCost: true,
    run: async (companyId, f) => {
      // stavke se najprije zbrajaju po uređaju (i računu — za broj računa bez COUNT DISTINCT),
      // a tek se 200 najboljih spaja s modelom, statusom i partnerom
      const rows = await reportSql<Array<{ id: string; serial: string; model: string; status: string; partner: string | null; cost: Prisma.Decimal; revenue: Prisma.Decimal; sale: Prisma.Decimal; rent: Prisma.Decimal; invoices: number }>>`
        WITH li AS (
          SELECT l."itemId", l."invoiceId", bool_or(NOT l."isCredit") AS inv, SUM(l.net) AS net,
                 SUM(l.net) FILTER (WHERE l."type" = 'SALE') AS sale, SUM(l.net) FILTER (WHERE l."type" = 'RENT') AS rent
          FROM (${revenueLinesSql(companyId, { year: f.year, from: f.from, to: f.to, partnerIds: [] }, { withItem: true })}) l
          GROUP BY 1, 2
        ), a AS (
          SELECT "itemId", SUM(net) AS revenue, SUM(sale) AS sale, SUM(rent) AS rent, COUNT(*) FILTER (WHERE inv)::int AS invoices
          FROM li GROUP BY 1
        ), top AS (
          SELECT it.id, it.serial, it."cost", it."modelId", it."statusId", it."partnerId", a.revenue, a.sale, a.rent, a.invoices
          FROM a JOIN "Item" it ON it.id = a."itemId" JOIN "DeviceModel" m ON m.id = it."modelId"
          WHERE TRUE ${itemFilterSql(f)}
          ORDER BY a.revenue - it."cost" DESC
          LIMIT 200
        )
        SELECT t.id, t.serial, concat_ws(' ', m.brand, m.name) AS model, s.name AS status, hp.name AS partner, t."cost", t.revenue, t.sale, t.rent, t.invoices
        FROM top t
        JOIN "DeviceModel" m ON m.id = t."modelId"
        JOIN "ItemStatus" s ON s.id = t."statusId"
        LEFT JOIN "Partner" hp ON hp.id = t."partnerId"
        ORDER BY t.revenue - t."cost" DESC`;
      const out: Row[] = rows.map((r) => {
        const rev = n(r.revenue);
        const cost = n(r.cost);
        return {
          serial: r.serial, model: r.model, status: r.status, partner: r.partner, invoices: r.invoices,
          sale: n(r.sale), rent: n(r.rent), revenue: rev, cost, profit: r2(rev - cost), roi: cost ? ((rev - cost) / cost) * 100 : null,
          _href: `/skladiste/${r.id}`,
        };
      });
      return {
        columns: [
          { key: 'serial', label: 'Serijski broj', kind: 'mono' },
          { key: 'model', label: 'Model' },
          { key: 'status', label: 'Status' },
          { key: 'partner', label: 'Kod partnera' },
          { key: 'invoices', label: 'Računa', kind: 'int' },
          { key: 'sale', label: 'Prodaja', kind: 'money' },
          { key: 'rent', label: 'Najam', kind: 'money' },
          { key: 'revenue', label: 'Ukupno', kind: 'money' },
          { key: 'cost', label: 'Nabavna', kind: 'money' },
          { key: 'profit', label: 'Zarada', kind: 'money' },
          { key: 'roi', label: 'Povrat', kind: 'pct', sum: false },
        ],
        rows: out,
        note: 'Povrat = zarada ÷ nabavna cijena. Uključene su stavke izdanih, nestorniranih računa u razdoblju na kojima je uređaj — za cijeli vijek uređaja odaberite godinu „Sve".',
      };
    },
  },
];
