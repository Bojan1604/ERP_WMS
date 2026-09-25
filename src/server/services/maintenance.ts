import 'server-only';
import { Prisma } from '@prisma/client';
import { db, type Tx } from '../db';
import { audit } from '../audit';
import { assert } from '../errors';
import { SYSTEM_STATUSES } from './company';
import type { Actor } from './items';
import { goodsExpenseMismatches, reconcileAllGoodsExpenses } from './goods-expense';

/**
 * Održavanje (F12): čišćenje dnevnika, provjera dosljednosti s popravkom gdje
 * je sigurno, vraćanje zadanih statusa i stanje baze. Sve je suženo na firmu.
 */

// ---------------------------------------------------------------- dnevnik

/** Briše zapise dnevnika starije od `days` dana (null = sve). Brisanje se i samo upisuje u dnevnik. */
export async function cleanAuditLog(tx: Tx, actor: Actor, days: number | null) {
  assert(days === null || (Number.isInteger(days) && days >= 0 && days <= 36500), 'Neispravan broj dana.');
  const before = days === null ? null : new Date(Date.now() - days * 86_400_000);
  const r = await tx.auditLog.deleteMany({ where: { companyId: actor.companyId, ...(before ? { at: { lt: before } } : {}) } });
  await audit(tx, actor, {
    entity: 'company', entityId: actor.companyId, action: 'log-clean',
    summary: days === null ? `Dnevnik promjena očišćen (${r.count} zapisa)` : `Iz dnevnika obrisani zapisi starije od ${days} dana (${r.count})`,
  });
  return r.count;
}

// ---------------------------------------------------------------- provjera dosljednosti

export interface IntegrityFinding {
  code: string;
  label: string;
  count: number;
  /** Nekoliko primjera s poveznicom. */
  samples: Array<{ label: string; href: string | null }>;
  /** Automatski popravak je siguran (ne mijenja poslovno značenje). */
  fixable: boolean;
  hint: string;
}

type Sample = { id: string; label: string };

const CHECKS: Array<{
  code: string; label: string; hint: string; fixable: boolean; href: (id: string) => string | null;
  sql: (c: string) => Prisma.Sql;
}> = [
  {
    code: 'state-mismatch', label: 'Preslika vrste statusa ne odgovara statusu uređaja', fixable: true, href: (id) => `/skladiste/${id}`,
    hint: 'Popravak usklađuje presliku (Item.state) s vrstom trenutnog statusa — status se ne mijenja.',
    sql: (c) => Prisma.sql`SELECT it.id, it.serial AS label FROM "Item" it JOIN "ItemStatus" s ON s.id = it."statusId" WHERE it."companyId" = ${c} AND it."state" <> s."kind"`,
  },
  {
    code: 'stock-with-partner', label: 'Uređaj na skladištu, a vezan uz partnera', fixable: true, href: (id) => `/skladiste/${id}`,
    hint: 'Uređaj na skladištu je „čist" — popravak uklanja partnera i podatke o izlazu.',
    sql: (c) => Prisma.sql`SELECT it.id, it.serial AS label FROM "Item" it WHERE it."companyId" = ${c} AND it."state" = 'IN_STOCK' AND it."partnerId" IS NOT NULL`,
  },
  {
    code: 'counter-behind', label: 'Brojač računa je iza već izdanih brojeva', fixable: true, href: () => '/postavke',
    hint: 'Popravak podiže brojač na najveći izdani redni broj (sljedeći račun dobiva broj +1).',
    sql: (c) => Prisma.sql`SELECT i."year"::text AS id, ('godina ' || i."year" || ': izdano do ' || MAX(i."seq") || ', brojač ' || COALESCE(MAX(dc."last"), 0)) AS label
      FROM "Invoice" i LEFT JOIN "DocumentCounter" dc ON dc."companyId" = i."companyId" AND dc."series" = 'INVOICE' AND dc."year" = i."year"
      WHERE i."companyId" = ${c} AND i."seq" IS NOT NULL GROUP BY i."year" HAVING MAX(i."seq") > COALESCE(MAX(dc."last"), 0)`,
  },
  {
    code: 'rented-no-contract', label: 'Uređaj u najmu nije ni na jednom ugovoru', fixable: false, href: (id) => `/skladiste/${id}`,
    hint: 'Dodajte uređaj na ugovor ili mu promijenite status (povrat na skladište).',
    sql: (c) => Prisma.sql`SELECT it.id, it.serial AS label FROM "Item" it WHERE it."companyId" = ${c} AND it."state" = 'RENTED' AND NOT EXISTS (SELECT 1 FROM "ContractItem" ci WHERE ci."itemId" = it.id)`,
  },
  {
    code: 'sold-no-invoice', label: 'Prodan uređaj bez računa', fixable: false, href: (id) => `/skladiste/${id}`,
    hint: 'Uređaj ima status prodaje, a nije ni na jednom izdanom računu prodaje — izdajte račun ili ispravite status.',
    sql: (c) => Prisma.sql`SELECT it.id, it.serial AS label FROM "Item" it WHERE it."companyId" = ${c} AND it."state" = 'SOLD'
      AND NOT EXISTS (SELECT 1 FROM "InvoiceLine" l JOIN "Invoice" i ON i.id = l."invoiceId" WHERE l."itemId" = it.id AND i."status" = 'ISSUED' AND i."kind" = 'INVOICE')`,
  },
  {
    code: 'contract-no-items', label: 'Aktivan ugovor bez uređaja', fixable: false, href: (id) => `/najam/ugovori/${id}`,
    hint: 'Dodajte uređaje na ugovor ili ga zatvorite.',
    sql: (c) => Prisma.sql`SELECT ct.id, ct."number" AS label FROM "Contract" ct WHERE ct."companyId" = ${c} AND ct."status" = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM "ContractItem" ci WHERE ci."contractId" = ct.id)`,
  },
  {
    code: 'closed-contract-rented', label: 'Uređaj u najmu na raskinutom ili isteklom ugovoru', fixable: false, href: (id) => `/skladiste/${id}`,
    hint: 'Najavite povrat (Skladište → Izlaz i povrat → Za povrat).',
    sql: (c) => Prisma.sql`SELECT it.id, it.serial AS label FROM "ContractItem" ci JOIN "Contract" ct ON ct.id = ci."contractId" JOIN "Item" it ON it.id = ci."itemId"
      WHERE ct."companyId" = ${c} AND ct."status" IN ('TERMINATED','EXPIRED') AND it."state" = 'RENTED'`,
  },
  {
    code: 'stock-no-warehouse', label: 'Uređaj na skladištu bez skladišta', fixable: false, href: (id) => `/skladiste/${id}`,
    hint: 'Uredite uređaj i odaberite skladište.',
    sql: (c) => Prisma.sql`SELECT it.id, it.serial AS label FROM "Item" it WHERE it."companyId" = ${c} AND it."state" = 'IN_STOCK' AND it."warehouseId" IS NULL`,
  },
  {
    code: 'duplicate-serial', label: 'Dupli serijski broj bez razlikovne napomene', fixable: false, href: (id) => `/skladiste?q=${encodeURIComponent(id)}`,
    hint: 'Upišite razlikovnu napomenu ili spojite/obrišite pogrešan unos.',
    sql: (c) => Prisma.sql`SELECT it.serial AS id, it.serial AS label FROM "Item" it WHERE it."companyId" = ${c} AND it."dupNote" IS NULL GROUP BY it.serial HAVING COUNT(*) > 1`,
  },
  {
    code: 'issued-no-number', label: 'Izdan račun bez broja', fixable: false, href: (id) => `/prodaja/racuni/${id}`,
    hint: 'Račun je izdan bez rednog broja — javite podršci.',
    sql: (c) => Prisma.sql`SELECT i.id, to_char(i."date", 'DD.MM.YYYY.') AS label FROM "Invoice" i WHERE i."companyId" = ${c} AND i."status" = 'ISSUED' AND i."number" IS NULL`,
  },
];

/** Provjera dosljednosti: broj nalaza i do 8 primjera po provjeri (upiti s LIMIT/COUNT u bazi). */
export async function integrityCheck(companyId: string): Promise<IntegrityFinding[]> {
  const [out, goods] = await Promise.all([
    Promise.all(
      CHECKS.map(async (ch): Promise<IntegrityFinding> => {
        const [cnt, rows] = await Promise.all([
          db.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM (${ch.sql(companyId)}) x`,
          db.$queryRaw<Sample[]>`SELECT * FROM (${ch.sql(companyId)}) x LIMIT 8`,
        ]);
        return { code: ch.code, label: ch.label, count: cnt[0]?.n ?? 0, samples: rows.map((r) => ({ label: String(r.label), href: ch.href(String(r.id)) })), fixable: ch.fixable, hint: ch.hint };
      }),
    ),
    goodsExpenseMismatches(db, companyId),
  ]);
  // trošak robe po narudžbenici: pravilo max(primke, računi za robu) nad stanjem baze (services/goods-expense.ts)
  out.push({
    code: 'goods-expense',
    label: 'Trošak robe po narudžbenici ne odgovara pravilu',
    count: goods.length,
    samples: goods.slice(0, 8).map((m) => ({ label: `${m.label}: ${m.booked.toFixed(2).replace('.', ',')} → ${m.expected.toFixed(2).replace('.', ',')} €`, href: m.href })),
    fixable: true,
    hint: 'Stari podaci (prije jednog pravila) mogu imati trošak robe knjižen i s primke i s računa. Popravak ponovno usklađuje vlastite troškove ulaznih računa po pravilu max(primke, računi za robu); troškovi primki se ne mijenjaju, a svaka narudžbenica dobiva zapis u dnevniku s prijašnjim iznosima.',
  });
  return out.filter((f) => f.count > 0);
}

/**
 * Popravak sigurnih nalaza. Vraća broj popravljenih zapisa po provjeri. S `goods: false` trošak robe
 * se ne usklađuje u ovoj transakciji (akcija ga radi poslije, po skupinama — reconcileGoodsExpensesChunked).
 */
export async function fixIntegrity(tx: Tx, actor: Actor, opts: { goods?: boolean } = {}): Promise<Record<string, number>> {
  const c = actor.companyId;
  const fixed: Record<string, number> = {};
  fixed['state-mismatch'] = await tx.$executeRaw`
    UPDATE "Item" it SET "state" = s."kind", "updatedAt" = now() FROM "ItemStatus" s
    WHERE s.id = it."statusId" AND it."companyId" = ${c} AND it."state" <> s."kind"`;
  fixed['stock-with-partner'] = await tx.$executeRaw`
    UPDATE "Item" SET "partnerId" = NULL, "outAt" = NULL, "outById" = NULL, "outPartnerId" = NULL, "outNote" = NULL, "updatedAt" = now()
    WHERE "companyId" = ${c} AND "state" = 'IN_STOCK' AND "partnerId" IS NOT NULL`;
  fixed['counter-behind'] = await tx.$executeRaw`
    INSERT INTO "DocumentCounter" ("companyId", "series", "year", "last")
    SELECT ${c}, 'INVOICE'::"Series", i."year", MAX(i."seq") FROM "Invoice" i WHERE i."companyId" = ${c} AND i."seq" IS NOT NULL GROUP BY i."year"
    ON CONFLICT ("companyId", "series", "year") DO UPDATE SET "last" = GREATEST("DocumentCounter"."last", EXCLUDED."last")
    WHERE "DocumentCounter"."last" < EXCLUDED."last"`;
  if (opts.goods !== false) fixed['goods-expense'] = await reconcileAllGoodsExpenses(tx, actor);
  const total = Object.values(fixed).reduce((a, b) => a + b, 0);
  await audit(tx, actor, { entity: 'company', entityId: c, action: 'integrity-fix', summary: `Provjera dosljednosti: automatski popravljeno ${total} zapisa`, diff: fixed });
  return fixed;
}

// ---------------------------------------------------------------- zadani statusi

/**
 * Vraća zadane statuse: sistemski status svake vrste dobiva zadani naziv i boju
 * (ako naziv nije zauzet drugim statusom), nedostajući se stvaraju, kao i
 * „Demo" i „Servisni uređaj". Vlastiti statusi i uređaji ostaju netaknuti.
 */
export async function resetDefaultStatuses(tx: Tx, actor: Actor) {
  const c = actor.companyId;
  const all = await tx.itemStatus.findMany({ where: { companyId: c } });
  const byName = new Map(all.map((s) => [s.name.toLowerCase(), s]));
  let created = 0;
  let renamed = 0;
  const skipped: string[] = [];
  for (const [sort, def] of SYSTEM_STATUSES.entries()) {
    const sys = all.find((s) => s.system && s.kind === def.kind);
    const taken = byName.get(def.name.toLowerCase());
    if (sys) {
      if (sys.name !== def.name || sys.color !== def.color || sys.sort !== sort) {
        if (taken && taken.id !== sys.id) {
          skipped.push(def.name);
          await tx.itemStatus.update({ where: { id: sys.id }, data: { color: def.color, sort } });
        } else {
          await tx.itemStatus.update({ where: { id: sys.id }, data: { name: def.name, color: def.color, sort } });
          renamed++;
        }
      }
    } else if (taken && taken.kind === def.kind) {
      // postojeći status iste vrste i naziva postaje sistemski
      await tx.itemStatus.update({ where: { id: taken.id }, data: { system: true, color: def.color, sort } });
      renamed++;
    } else {
      await tx.itemStatus.create({ data: { companyId: c, name: taken ? `${def.name} (sustav)` : def.name, kind: def.kind, color: def.color, system: true, sort } });
      created++;
    }
  }
  for (const extra of [{ name: 'Demo', color: 'teal', sort: 20 }, { name: 'Servisni uređaj', color: 'orange', sort: 21 }]) {
    if (!byName.has(extra.name.toLowerCase())) {
      await tx.itemStatus.create({ data: { companyId: c, name: extra.name, kind: 'OTHER', color: extra.color, sort: extra.sort } });
      created++;
    }
  }
  await audit(tx, actor, {
    entity: 'status', action: 'reset', summary: `Vraćeni zadani statusi: ${created} dodano, ${renamed} vraćeno na zadano${skipped.length ? `; naziv zauzet: ${skipped.join(', ')}` : ''}`,
  });
  return { created, renamed, skipped };
}

// ---------------------------------------------------------------- stanje baze

/** Broj zapisa po vrsti za firmu (kartica „Stanje baze"). */
export async function databaseStats(companyId: string) {
  const w = { where: { companyId } };
  const [items, invoices, partners, models, users, contracts, services, serviceOrders, expenses, priceAgreements, audit, attachments, attSize, emails, portalUsers] =
    await Promise.all([
      db.item.count(w), db.invoice.count(w), db.partner.count(w), db.deviceModel.count(w),
      db.user.count({ where: { OR: [{ companyId }, { companies: { some: { companyId } } }] } }),
      db.contract.count(w), db.service.count(w), db.serviceOrder.count(w), db.expense.count(w), db.priceAgreement.count(w),
      db.auditLog.count(w), db.attachment.count(w), db.attachment.aggregate({ ...w, _sum: { size: true } }), db.emailLog.count(w), db.portalUser.count(w),
    ]);
  return {
    rows: [
      ['Uređaji', items], ['Računi', invoices], ['Partneri', partners], ['Modeli', models], ['Korisnici', users], ['Ugovori o najmu', contracts],
      ['Usluge', services], ['Servisni nalozi', serviceOrders], ['Troškovi', expenses], ['Dogovorene cijene', priceAgreements],
      ['Prilozi', attachments], ['Poslane e-poruke', emails], ['Korisnici portala', portalUsers], ['Zapisa u dnevniku', audit],
    ] as Array<[string, number]>,
    attachmentBytes: attSize._sum.size ?? 0,
  };
}
