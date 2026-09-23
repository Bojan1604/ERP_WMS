import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Prisma, Series, StatusKind } from '@prisma/client';
import { db, type Tx } from '../db';
import { DomainError } from '../errors';
import { DEFAULT_EXPENSE_CATEGORIES } from '../services/company';
import { sanitizeCompanySettings } from '@/domain/company';
import { docNumberParts, planCounts, type ImportPlan, type Key, type PlanCounter } from './plan';
import { insertDocuments } from './run-docs';
import { fromISO } from '@/domain/dates';

/**
 * Upis plana uvoza u bazu — u novu firmu ili u postojeću.
 *
 * Brzina: id-evi se stvaraju u memoriji, zapisi idu skupno (createMany u
 * dijelovima po 1000), bez upita po retku. Sve je jedna transakcija s
 * produženim rokom: uvoz uspije u cijelosti ili se ne upiše ništa.
 *
 * U postojeću firmu: zapisi koji već postoje (po prirodnom ključu — serijski +
 * razlikovna napomena, OIB ili naziv partnera, proizvođač + model, godina +
 * redni broj računa, broj dokumenta…) se preskaču, a veze na njih vode na
 * postojeći zapis.
 */

export type ImportTarget = { kind: 'new'; name: string } | { kind: 'current' };

export interface ImportActor { id: string; name: string; email: string; companyId: string }

export interface ImportResult {
  companyId: string;
  companyName: string;
  created: Record<string, number>;
  skipped: Record<string, number>;
  durationMs: number;
  steps: Array<{ name: string; rows: number; ms: number }>;
  /** Novi administrator nove firme — lozinka se prikazuje samo jednom. */
  admin?: { email: string; password: string };
}

export const CHUNK = 1000;
export const IMPORT_TIMEOUT_MS = 30 * 60_000;

export const newId = () => randomUUID();
export const d = (s: string | null | undefined) => (s ? fromISO(s) : null);
export const ts = (s: string | null | undefined) => (s ? new Date(s) : undefined);

export function* chunks<T>(rows: T[], size = CHUNK): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

/** Tablice s poljem `updatedAt` (Prisma ga puni sama, baza nema zadanu vrijednost). */
const HAS_UPDATED_AT = new Set(['Partner', 'Item', 'Invoice', 'Contract', 'Quote', 'PurchaseOrder', 'SupplierInvoice', 'ServiceOrder', 'Expense']);

/**
 * Skupni upis: dio po dio (2000 redaka) kao JEDAN JSON parametar koji baza
 * raspakira (`json_populate_recordset`) — višestruko brže od createMany s
 * desecima parametara po retku. Nazivi stupaca su nazivi polja Prisma modela.
 * Vraća broj upisanih redaka (uz `skipDuplicates` preskače sudare jedinstvenih ključeva).
 */
export async function bulkInsert(tx: Tx, table: string, rows: object[], opts: { skipDuplicates?: boolean; size?: number } = {}): Promise<number> {
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (HAS_UPDATED_AT.has(table) && !cols.includes('updatedAt')) cols.push('updatedAt');
  const hasCreated = cols.includes('createdAt');
  const list = cols.map((c) => `"${c}"`).join(', ');
  const sql = `INSERT INTO "${table}" (${list}) SELECT ${list} FROM json_populate_recordset(NULL::"${table}", $1::json)${opts.skipDuplicates ? ' ON CONFLICT DO NOTHING' : ''}`;
  let n = 0;
  for (const part of chunks(rows, opts.size ?? 2000)) {
    const data = part.map((r) => {
      const o = { ...(r as Record<string, unknown>) };
      if (hasCreated && (o.createdAt === undefined || o.createdAt === null)) o.createdAt = now;
      if (HAS_UPDATED_AT.has(table)) o.updatedAt ??= now;
      return o;
    });
    n += await tx.$executeRawUnsafe(sql, JSON.stringify(data, (_k, v) => (v === undefined ? null : v)));
  }
  return n;
}

/** Stanje jednog uvoza: ciljna firma, preslikavanje ključeva u id-eve, brojila. */
export class RunCtx {
  readonly ids: Record<string, Map<Key, string>> = {};
  readonly created: Record<string, number> = {};
  readonly skipped: Record<string, number> = {};
  readonly steps: ImportResult['steps'] = [];
  /** Ključevi zapisa koji su stvoreni u ovom uvozu (ne preskočeni). */
  readonly fresh: Record<string, Set<Key>> = {};
  /** Povijest uređaja koja se upisuje na kraju (IMPORT + vraćeni zapisi). */
  readonly pendingEvents: Prisma.ItemEventCreateManyInput[] = [];
  private t = Date.now();

  constructor(readonly tx: Tx, readonly companyId: string, readonly existing: boolean, readonly actor: ImportActor, readonly log: (m: string) => void) {}

  map(entity: string) {
    return (this.ids[entity] ??= new Map());
  }
  id(entity: string, key: Key | null | undefined): string | null {
    return key ? (this.map(entity).get(key) ?? null) : null;
  }
  /** Novi zapis: id + oznaka da je stvoren u ovom uvozu. */
  assign(entity: string, key: Key): string {
    const id = newId();
    this.map(entity).set(key, id);
    (this.fresh[entity] ??= new Set()).add(key);
    return id;
  }
  isFresh(entity: string, key: Key | null | undefined) {
    return !!key && !!this.fresh[entity]?.has(key);
  }
  count(entity: string, created: number, skipped = 0) {
    this.created[entity] = (this.created[entity] ?? 0) + created;
    if (skipped) this.skipped[entity] = (this.skipped[entity] ?? 0) + skipped;
  }
  step(name: string, rows: number) {
    const now = Date.now();
    this.steps.push({ name, rows, ms: now - this.t });
    this.log(`[uvoz] ${name}: ${rows} u ${now - this.t} ms`);
    this.t = now;
  }
}

// ---------------------------------------------------------------- šifrarnici i partneri

const low = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

async function insertMasterData(c: RunCtx, plan: ImportPlan) {
  const { tx, companyId } = c;
  const ex = c.existing;
  const byName = async (rows: Array<{ id: string; name: string }>) => new Map(rows.map((r) => [low(r.name), r.id]));

  // skladišta, kategorije, usluge, kategorije troškova — prirodni ključ je naziv
  const simple = async <R extends { key: Key; name: string }>(
    entity: string,
    rows: R[],
    existingRows: () => Promise<Array<{ id: string; name: string }>>,
    create: (data: Array<R & { id: string }>) => Promise<unknown>,
  ) => {
    const have = ex ? await byName(await existingRows()) : new Map<string, string>();
    const out: Array<R & { id: string }> = [];
    for (const r of rows) {
      const found = have.get(low(r.name));
      if (found) {
        c.map(entity).set(r.key, found);
        c.count(entity, 0, 1);
      } else {
        const id = c.assign(entity, r.key);
        have.set(low(r.name), id);
        out.push({ ...r, id });
      }
    }
    for (const part of chunks(out)) await create(part);
    c.count(entity, out.length);
    c.step(entity, out.length);
  };

  await simple('warehouses', plan.warehouses, () => tx.warehouse.findMany({ where: { companyId }, select: { id: true, name: true } }),
    (rows) => tx.warehouse.createMany({ data: rows.map((r) => ({ id: r.id, companyId, name: r.name, address: r.address, active: r.active, sort: r.sort })) }));
  await simple('categories', plan.categories, () => tx.category.findMany({ where: { companyId }, select: { id: true, name: true } }),
    (rows) => tx.category.createMany({ data: rows.map((r) => ({ id: r.id, companyId, name: r.name, sort: r.sort })) }));
  await simple('services', plan.services, () => tx.service.findMany({ where: { companyId }, select: { id: true, name: true } }),
    (rows) => tx.service.createMany({ data: rows.map((r) => ({ id: r.id, companyId, name: r.name, unit: r.unit, price: r.price, kpd: r.kpd, active: r.active })) }));
  const expCats = [...plan.expenseCategories];
  if (!ex) for (const name of DEFAULT_EXPENSE_CATEGORIES) if (!expCats.some((e) => low(e.name) === low(name))) expCats.push({ key: `default:${name}`, name });
  await simple('expenseCategories', expCats, () => tx.expenseCategory.findMany({ where: { companyId }, select: { id: true, name: true } }),
    (rows) => tx.expenseCategory.createMany({ data: rows.map((r) => ({ id: r.id, companyId, name: r.name })) }));

  // statusi: naziv je jedinstven; sistemski samo ako firma već nema sistemski te vrste
  {
    const have = ex ? await tx.itemStatus.findMany({ where: { companyId }, select: { id: true, name: true, kind: true, system: true } }) : [];
    const names = new Map(have.map((s) => [low(s.name), s]));
    const systemKinds = new Set<StatusKind>(have.filter((s) => s.system).map((s) => s.kind));
    const rows: Prisma.ItemStatusCreateManyInput[] = [];
    for (const s of plan.statuses) {
      const found = names.get(low(s.name));
      if (found) {
        c.map('statuses').set(s.key, found.id);
        c.count('statuses', 0, 1);
        continue;
      }
      const id = c.assign('statuses', s.key);
      const system = s.system && !systemKinds.has(s.kind);
      if (system) systemKinds.add(s.kind);
      rows.push({ id, companyId, name: s.name, kind: s.kind, color: s.color, system, sort: s.sort });
      names.set(low(s.name), { id, name: s.name, kind: s.kind, system });
    }
    await tx.itemStatus.createMany({ data: rows });
    c.count('statuses', rows.length);
    c.step('statuses', rows.length);
  }

  // modeli: proizvođač + naziv
  {
    const have = ex ? await tx.deviceModel.findMany({ where: { companyId }, select: { id: true, brand: true, name: true } }) : [];
    const keys = new Map(have.map((m) => [`${low(m.brand)}|${low(m.name)}`, m.id]));
    const rows: Prisma.DeviceModelCreateManyInput[] = [];
    for (const m of plan.models) {
      const nk = `${low(m.brand)}|${low(m.name)}`;
      const found = keys.get(nk);
      if (found) {
        c.map('models').set(m.key, found);
        c.count('models', 0, 1);
        continue;
      }
      const id = c.assign('models', m.key);
      keys.set(nk, id);
      rows.push({
        id, companyId, categoryId: c.id('categories', m.categoryKey), brand: m.brand, name: m.name, code: m.code, kpd: m.kpd,
        salePrice: m.salePrice, rentPrice: m.rentPrice, marginPct: m.marginPct, warrantyMonths: m.warrantyMonths, minStock: m.minStock, specs: m.specs, active: m.active,
      });
    }
    await bulkInsert(tx, 'DeviceModel', rows);
    c.count('models', rows.length);
    c.step('models', rows.length);
  }

  // partneri: OIB, a bez OIB-a naziv
  {
    const have = ex ? await tx.partner.findMany({ where: { companyId }, select: { id: true, name: true, oib: true } }) : [];
    const byOib = new Map(have.filter((p) => p.oib).map((p) => [p.oib!.trim(), p.id]));
    const byPName = new Map(have.map((p) => [low(p.name), p.id]));
    const rows: Prisma.PartnerCreateManyInput[] = [];
    for (const p of plan.partners) {
      const found = ex ? (p.oib ? byOib.get(p.oib.trim()) : undefined) ?? (!p.oib ? byPName.get(low(p.name)) : undefined) : undefined;
      if (found) {
        c.map('partners').set(p.key, found);
        c.count('partners', 0, 1);
        continue;
      }
      const id = c.assign('partners', p.key);
      rows.push({
        id, companyId, name: p.name, oib: p.oib, vatId: p.vatId, address: p.address, zip: p.zip, city: p.city, country: p.country, email: p.email,
        phone: p.phone, iban: p.iban, contactPerson: p.contactPerson, isCustomer: p.isCustomer, isSupplier: p.isSupplier, excluded: p.excluded,
        paymentTermDays: p.paymentTermDays, note: p.note,
      });
    }
    await bulkInsert(tx, 'Partner', rows);
    c.count('partners', rows.length);
    c.step('partners', rows.length);
  }

  // dogovorene cijene (jedinstveno partner + model)
  {
    const rows = plan.priceAgreements
      .map((a) => ({ id: newId(), companyId, partnerId: c.id('partners', a.partnerKey)!, modelId: c.id('models', a.modelKey)!, salePrice: a.salePrice, rentPrice: a.rentPrice }))
      .filter((a) => a.partnerId && a.modelId);
    const n = await bulkInsert(tx, 'PriceAgreement', rows, { skipDuplicates: true });
    c.count('priceAgreements', n, rows.length - n);
    c.step('priceAgreements', n);
  }
}

// ---------------------------------------------------------------- brojači

/** Brojači za postojeću firmu: samo izvorni brojevi (dodijeljeni se uzimaju iz baze pri upisu). */
function sourceCounters(plan: ImportPlan): PlanCounter[] {
  const max = new Map<string, number>();
  const see = (series: Series, year: number, seq: number) => {
    const k = `${series}|${year}`;
    if (seq > (max.get(k) ?? 0)) max.set(k, seq);
  };
  for (const i of plan.invoices) if (i.seq) see('INVOICE', i.year, i.seq);
  const docs: Array<[Series, Array<{ number: string; generatedNumber?: boolean }>]> = [
    ['CONTRACT', plan.contracts], ['QUOTE', plan.quotes], ['ORDER', plan.orders], ['RECEIPT', plan.receipts], ['TRANSFER', plan.transfers], ['SERVICE', plan.serviceOrders],
  ];
  for (const [series, rows] of docs) {
    for (const r of rows) {
      const p = !r.generatedNumber ? docNumberParts(r.number) : null;
      if (p) see(series, p.year, p.seq);
    }
  }
  return [...max.entries()].map(([k, last]) => ({ series: k.split('|')[0] as Series, year: Number(k.split('|')[1]), last }));
}

async function raiseCounters(tx: Tx, companyId: string, counters: PlanCounter[]) {
  for (const k of counters) {
    await tx.$executeRaw`
      INSERT INTO "DocumentCounter" ("companyId", "series", "year", "last")
      VALUES (${companyId}, ${k.series}::"Series", ${k.year}, ${k.last})
      ON CONFLICT ("companyId", "series", "year") DO UPDATE SET "last" = GREATEST("DocumentCounter"."last", EXCLUDED."last")`;
  }
}

// ---------------------------------------------------------------- nova firma i administrator

function adminEmail(email: string, companyName: string, taken: (e: string) => Promise<boolean>) {
  const slug = companyName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).replace(/-[a-z0-9]{0,2}$/, '') || 'firma';
  const [local, domain] = email.includes('@') ? email.split('@') : [email, 'uvoz.local'];
  return (async () => {
    for (let i = 1; i < 1000; i++) {
      const e = `${local.split('+')[0]}+${slug}${i > 1 ? `-${i}` : ''}@${domain}`.toLowerCase();
      if (!(await taken(e))) return e;
    }
    throw new DomainError('Nije moguće složiti jedinstvenu e-adresu administratora.');
  })();
}

// ---------------------------------------------------------------- glavno

export async function runImport(
  plan: ImportPlan,
  opts: { target: ImportTarget; actor: ImportActor; log?: (m: string) => void; summary?: string },
): Promise<ImportResult> {
  const t0 = Date.now();
  const log = opts.log ?? ((m: string) => console.info(m));
  const counts = planCounts(plan);
  if (!counts.items && !counts.invoices && !counts.partners && !counts.models) throw new DomainError('Datoteka nema podataka za uvoz.');

  return db.$transaction(async (tx) => {
    let companyId = opts.actor.companyId;
    let companyName: string;
    let admin: ImportResult['admin'];
    const existing = opts.target.kind === 'current';

    if (opts.target.kind === 'new') {
      // plan je već očišćen pri čitanju; ponovno — plan može doći i iz drugog izvora
      const { name: _ignored, ...settings } = sanitizeCompanySettings(plan.company as Record<string, unknown>).company;
      companyName = opts.target.name.trim() || plan.company.name || 'Uvezena firma';
      const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      const company = await tx.company.create({ data: { ...(clean as Omit<Prisma.CompanyCreateInput, 'name'>), name: companyName } });
      companyId = company.id;
      // administrator nove firme: korisnik pripada jednoj firmi, pa se stvara novi račun
      const password = randomBytes(12).toString('base64url');
      const email = await adminEmail(opts.actor.email, companyName, async (e) => !!(await tx.user.findUnique({ where: { email: e }, select: { id: true } })));
      await tx.user.create({ data: { companyId, email, name: opts.actor.name, passwordHash: await bcrypt.hash(password, 10), role: 'ADMIN' } });
      admin = { email, password };
    } else {
      companyName = (await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } })).name;
    }

    const c = new RunCtx(tx, companyId, existing, opts.actor, log);
    await insertMasterData(c, plan);
    await insertDocuments(c, plan);

    await raiseCounters(tx, companyId, existing ? sourceCounters(plan) : plan.counters);
    c.step('counters', plan.counters.length);

    const created = Object.entries(c.created).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ');
    const summary = opts.summary ?? `Uvoz podataka (${plan.source.label})`;
    const diff = { source: plan.source, created: c.created, skipped: c.skipped, warnings: plan.warningCounts } as unknown as Prisma.InputJsonValue;
    await tx.auditLog.create({
      data: { companyId, userId: existing ? opts.actor.id : null, userName: opts.actor.name, entity: 'import', action: 'import', summary: `${summary}: ${created || 'ništa novo'}`, diff },
    });
    if (!existing) {
      await tx.auditLog.create({
        data: {
          companyId: opts.actor.companyId, userId: opts.actor.id, userName: opts.actor.name, entity: 'import', entityId: companyId, action: 'import',
          summary: `Stvorena firma „${companyName}" uvozom podataka (${plan.source.label}); administrator ${admin!.email}`, diff,
        },
      });
    }
    return { companyId, companyName, created: c.created, skipped: c.skipped, durationMs: Date.now() - t0, steps: c.steps, admin };
  }, { maxWait: 20_000, timeout: IMPORT_TIMEOUT_MS });
}
