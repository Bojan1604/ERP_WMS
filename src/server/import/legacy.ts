/**
 * Uvoz baze stare verzije (cijela firma u jednom JSON objektu) → plan uvoza.
 *
 * Čista pretvorba bez baze: prepoznaje oblik datoteke, čita svaku kolekciju
 * tolerantno (zod), preslikava sve entitete u oblik ove aplikacije i skuplja
 * upozorenja (nepostojeće veze, dupli serijski, nečitljivi datumi i brojevi,
 * nepoznati statusi). Upis radi `run.ts`.
 */
import type { StatusKind } from '@prisma/client';
import type { z } from 'zod';
import { LegacyCtx } from './legacy-ctx';
import {
  detectLegacy, legacyAudit, legacyCategory, legacyContract, legacyExpense, legacyInbound, legacyInvoice, legacyItem, legacyModel,
  legacyOrder, legacyPackage, legacyPartner, legacyPriceList, legacyQuote, legacyReceipt, legacyRma, legacyService, legacyStatus, legacyTransfer,
  legacyUser, legacyWarehouse, type LegacyDb,
} from './legacy-parse';
import { applySalePrices, mapInvoices, mapQuotes } from './legacy-sales';
import { mapContracts, mapRent } from './legacy-rent';
import { mapAudit, mapExpenses, mapInbound, mapOrders, mapReceipts, mapRma, mapTransfers } from './legacy-other';
import { linkItemInvoices, mapItems } from './legacy-items';
import { cleanSpec, computeInvoiceTotals, emptyPlan, normalizeItemState, type ImportPlan, type Key, type PlanCompany } from './plan';
import { SYSTEM_STATUSES } from '@/server/services/company';
import { EU_COUNTRIES } from '@/domain/tax';
import { today as todayFn } from '@/domain/dates';
import { sanitizeCompanySettings } from '@/domain/company';

export { detectLegacy };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Zapisi kolekcije kroz shemu; zapis koji nije objekt se preskače uz upozorenje. */
function rows<S extends z.ZodTypeAny>(ctx: LegacyCtx, db: LegacyDb, name: string, schema: S): Array<z.infer<S>> {
  const arr = db[name];
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr)) {
    ctx.w.warn('collection', name, `Kolekcija „${name}" nije popis — preskočena.`);
    return [];
  }
  const out: Array<z.infer<S>> = [];
  for (const [i, r] of arr.entries()) {
    const p = schema.safeParse(r);
    if (p.success) out.push(p.data);
    else ctx.w.warn('record', name, `${name} #${i + 1}: zapis nije čitljiv — preskočen.`);
  }
  return out;
}

// ---------------------------------------------------------------- postavke i korisnici

/** Paketi (Marže → Paketi): naziv, cijena, napomena i uređaji (nepostojeći uređaji se izostavljaju). */
function mapPackages(ctx: LegacyCtx, list: Array<z.infer<typeof legacyPackage>>) {
  const out: NonNullable<ImportPlan['packages']> = [];
  for (const [i, p] of list.entries()) {
    const name = (p.name || `Paket ${i + 1}`).slice(0, 200);
    const itemKeys = [...new Set(p.itemIds.map((id) => ctx.items.get(id)?.key).filter((k): k is Key => !!k))];
    if (itemKeys.length < p.itemIds.length) ctx.w.warn('ref-item', 'paket', `Paket „${name}": ${p.itemIds.length - itemKeys.length} uređaja ne postoji — izostavljeni.`);
    const price = ctx.money(p.price, `Paket ${name}`, 'cijena', null);
    out.push({ key: p.id ?? ctx.genKey('package'), name, price: price && price > 0 ? price : null, note: p.note || null, itemKeys, createdAt: ctx.ts(p.createdAt) });
  }
  ctx.plan.packages = out;
}

const ROLE: Record<string, string> = { admin: 'ADMIN', voditelj: 'MANAGER', prodaja: 'SALES', skladiste: 'WAREHOUSE', gost: 'ACCOUNTANT' };

function mapSettings(ctx: LegacyCtx, s: Record<string, unknown>): PlanCompany {
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string).trim() || null : null);
  const n = (k: string) => {
    const v = typeof s[k] === 'string' ? Number(String(s[k]).replace(',', '.')) : s[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  // stari „invoicePrefix" (npr. ZG-1) → prostor i uređaj
  let premises = str('invoicePremises');
  let device = str('invoiceDevice');
  const prefix = str('invoicePrefix');
  if (!premises && prefix) {
    const m = /^(.*?)[-/_]?(\d+)$/.exec(prefix);
    premises = m ? m[1] : prefix;
    device ??= m ? m[2] : '1';
  }
  const [street, rest] = (str('companyAddress') ?? '').split(/,\s*/);
  const zipCity = /^(\d{5})\s+(.+)$/.exec(rest ?? '');
  ctx.vatRegistered = s.vatRegistered !== false;
  // brojači računa po godini (samo rastu) i početni broj iz starog programa
  if (isObj(s.invoiceCounters)) {
    for (const [y, v] of Object.entries(s.invoiceCounters)) if (Number(v) > 0 && /^\d{4}$/.test(y)) ctx.numbers.seen('INVOICE', Number(y), Number(v));
  }
  const startSeq = n('invoiceStartSeq');
  if (startSeq && startSeq > 1) ctx.numbers.seen('INVOICE', Number(str('invoiceStartYear') ?? ctx.today.slice(0, 4)), startSeq - 1);
  const logo = str('companyLogo') ?? str('logo');
  return {
    name: str('companyName') ?? undefined,
    oib: str('companyOib'),
    vatId: str('companyVatId'),
    address: str('companyStreet') ?? (street || null),
    zip: str('companyZip') ?? zipCity?.[1] ?? null,
    city: str('companyCity') ?? zipCity?.[2] ?? null,
    country: str('companyCountry') ?? 'HR',
    iban: str('companyIban'),
    bank: str('companyBank'),
    email: str('companyEmail'),
    phone: str('companyPhone'),
    web: str('companyWeb'),
    logo: logo && logo.startsWith('data:') && logo.length < 2_000_000 ? logo : null,
    currency: str('currency') ?? 'EUR',
    vatRegistered: ctx.vatRegistered,
    vatRate: n('vatRate'),
    overdueDays: n('overdueDays'),
    paymentTermDays: n('paymentTermDays'),
    quoteValidDays: n('quoteValidDays'),
    defaultMarginPct: n('defaultMarginPct'),
    defaultWarrantyMonths: n('warrantyMonths'),
    invoicePremises: premises ?? undefined,
    invoiceDevice: device ?? undefined,
    invoiceSeparator: str('invoiceSeparator') ?? undefined,
    invoiceFooter: str('invoiceFooter') ?? str('companyLegalForm'),
  };
}

// ---------------------------------------------------------------- statusi

const FLAG_KIND: Array<[keyof z.infer<typeof legacyStatus>, StatusKind, RegExp]> = [
  ['rented', 'RENTED', /najm/i],
  ['sold', 'SOLD', /prodan|prodano/i],
  ['returning', 'RETURNING', /dolask|povrat/i],
  ['reserved', 'RESERVED', /iza[šs]l/i],
  ['writtenOff', 'WRITTEN_OFF', /otpis/i],
  ['rma', 'SERVICE', /pokvar|kvar/i],
  ['inStock', 'IN_STOCK', /skladi/i],
];
const COLORS = new Set(['gray', 'green', 'blue', 'purple', 'red', 'amber', 'teal', 'orange']);

function mapStatuses(ctx: LegacyCtx, list: Array<z.infer<typeof legacyStatus>>) {
  // uloga po zastavici, a ako je nijedan status nema — po nazivu (kao ensureStatuses u staroj verziji)
  for (const [flag, , re] of FLAG_KIND) {
    if (list.some((s) => s[flag])) continue;
    const byName = list.find((s) => re.test(s.name) && !FLAG_KIND.some(([f]) => s[f]));
    if (byName) {
      (byName as Record<string, unknown>)[flag] = true;
      ctx.w.info('status-by-name', 'status', `Status „${byName.name}" prepoznat po nazivu kao ${String(flag)}.`);
    }
  }
  const byName = new Map<string, { key: Key; kind: StatusKind }>();
  for (const [i, s] of list.entries()) {
    const flags = FLAG_KIND.filter(([f]) => s[f]);
    const kind: StatusKind = flags[0]?.[1] ?? 'OTHER';
    if (flags.length > 1 && !(flags.length === 2 && flags[1][1] === 'IN_STOCK')) {
      ctx.w.warn('status-flags', 'status', `Status „${s.name}" ima više uloga (${flags.map(([f]) => String(f)).join(', ')}) — uzeta ${String(flags[0][0])}.`);
    }
    let name = s.name || `Status ${i + 1}`;
    const prev = byName.get(name.toLowerCase());
    if (prev && prev.kind === kind) {
      if (s.id) ctx.statuses.set(s.id, { key: prev.key, kind, name });
      continue;
    }
    if (prev) name = `${name} (${i + 1})`;
    const key = s.id ?? ctx.genKey('status');
    if (s.color && !COLORS.has(s.color)) ctx.w.info('status-color', 'status', `Status „${name}": boja „${s.color}" zamijenjena sivom.`);
    ctx.plan.statuses.push({ key, name, kind, color: COLORS.has(s.color) ? s.color : 'gray', system: false, sort: i });
    byName.set(name.toLowerCase(), { key, kind });
    if (s.id) ctx.statuses.set(s.id, { key, kind, name });
  }
  // svaka vrsta koju program koristi ima sistemski status
  for (const def of SYSTEM_STATUSES) {
    const first = ctx.plan.statuses.find((s) => s.kind === def.kind);
    if (first) {
      first.system = true;
      continue;
    }
    let name = def.name;
    if (byName.has(name.toLowerCase())) name = `${name} (sustav)`;
    ctx.plan.statuses.push({ key: ctx.genKey('status'), name, kind: def.kind, color: def.color, system: true, sort: 100 + ctx.plan.statuses.length });
    byName.set(name.toLowerCase(), { key: ctx.plan.statuses.at(-1)!.key, kind: def.kind });
  }
}


// ---------------------------------------------------------------- partneri

/** Država partnera → ISO. Stara verzija: `countryCode` (ISO) i `country` ∈ HR | EU | ostalo. */
function countryOf(ctx: LegacyCtx, p: z.infer<typeof legacyPartner>): string {
  const iso = (v: string) => (/^[A-Za-z]{2}$/.test(v) ? v.toUpperCase().replace('EL', 'GR').replace('UK', 'GB') : null);
  const code = iso(p.countryCode);
  if (code) return code;
  const c = p.country.toUpperCase();
  if (c && c !== 'EU' && iso(c)) return iso(c)!;
  const fromVat = iso(p.vatId.slice(0, 2));
  if (c === 'EU') {
    if (fromVat && fromVat !== 'HR' && EU_COUNTRIES.has(fromVat)) return fromVat;
    ctx.w.warn('partner-country', 'partner', `Partner „${p.name}": država je samo „EU" — postavljena Njemačka (DE); porezni tretman (EU) je isti, ali za eRačun ispravite državu na kartici partnera.`);
    return 'DE';
  }
  if (c === 'OSTALO' || c === 'OTHER') {
    if (fromVat && !EU_COUNTRIES.has(fromVat)) return fromVat;
    ctx.w.warn('partner-country', 'partner', `Partner „${p.name}": država „ostalo" bez ISO oznake — postavljene SAD (US) radi poreza izvan EU; ispravite na kartici partnera.`);
    return 'US';
  }
  if (c) ctx.w.warn('partner-country', 'partner', `Partner „${p.name}": nepoznata država „${p.country}" — HR.`);
  return 'HR';
}

// ---------------------------------------------------------------- glavno

export interface LegacyMapResult { plan: ImportPlan; notes: string[] }

/** Stara baza (bilo koji podržani oblik) → plan uvoza. Vraća null ako oblik nije prepoznat. */
export function mapLegacy(raw: unknown, opts: { today?: string } = {}): LegacyMapResult | null {
  const det = detectLegacy(raw);
  if (!det) return null;
  const plan = emptyPlan({ format: det.format, label: det.label, companyName: det.companyName, exportedAt: det.exportedAt, version: det.version });
  const ctx = new LegacyCtx(plan, opts.today ?? todayFn());
  const db = det.db;

  const settings = sanitizeCompanySettings(mapSettings(ctx, isObj(db.settings) ? db.settings : {}) as Record<string, unknown>);
  plan.company = settings.company;
  for (const note of settings.notes) ctx.w.warn('company-settings', 'Firma', note);
  for (const u of rows(ctx, db, 'users', legacyUser)) {
    if (u.id) ctx.userNames.set(u.id, u.name || u.email || u.id);
    if (u.role === 'klijent') continue; // pristup RMA portalu ne postoji u novoj verziji
    plan.users.push({ name: u.name || u.email, email: u.email || null, role: ROLE[u.role] ?? 'SALES', active: u.active !== false });
  }

  // šifrarnici — duplikati po nazivu se spajaju (naziv je jedinstven u firmi)
  const whByName = new Map<string, Key>();
  for (const [i, w] of rows(ctx, db, 'warehouses', legacyWarehouse).entries()) {
    const name = w.name || w.code || `Skladište ${i + 1}`;
    const prev = whByName.get(name.toLowerCase());
    const key = prev ?? w.id ?? ctx.genKey('warehouse');
    if (!prev) {
      plan.warehouses.push({ key, name, address: w.address || null, active: w.active !== false, sort: i });
      whByName.set(name.toLowerCase(), key);
    } else ctx.w.info('merge', 'skladište', `Skladište „${name}" se ponavlja — spojeno.`);
    if (w.id) ctx.warehouses.set(w.id, key);
  }
  const catByName = new Map<string, Key>();
  for (const [i, c] of rows(ctx, db, 'categories', legacyCategory).entries()) {
    const name = c.name || `Kategorija ${i + 1}`;
    const prev = catByName.get(name.toLowerCase());
    const key = prev ?? c.id ?? ctx.genKey('category');
    if (!prev) {
      plan.categories.push({ key, name, sort: i });
      catByName.set(name.toLowerCase(), key);
    }
    if (c.id) ctx.categories.set(c.id, key);
  }
  const modelByName = new Map<string, Key>();
  for (const [i, m] of rows(ctx, db, 'models', legacyModel).entries()) {
    const where = `Model ${[m.brand, m.name].filter(Boolean).join(' ') || `#${i + 1}`}`;
    const name = m.name || m.brand || `Model ${i + 1}`;
    const brand = m.name ? m.brand || null : null;
    const nk = `${(brand ?? '').toLowerCase()}|${name.toLowerCase()}`;
    const prev = modelByName.get(nk);
    const key = prev ?? m.id ?? ctx.genKey('model');
    if (m.id) ctx.models.set(m.id, key);
    if (prev) {
      ctx.w.info('merge', 'model', `${where} se ponavlja — spojen s prvim.`);
      continue;
    }
    modelByName.set(nk, key);
    ctx.modelLabels.set(key, [brand, name].filter(Boolean).join(' '));
    const sale = ctx.money(m.price ?? m.salePrice, where, 'cijena', null);
    const rent = ctx.money(m.rentPrice ?? m.rentMonthly, where, 'najam', null);
    const specs = m.specs || [m.cpu, m.screen, m.os].map(cleanSpec).filter(Boolean).join(' · ');
    plan.models.push({
      key, categoryKey: m.categoryId ? (ctx.categories.get(m.categoryId) ?? null) : null, brand, name, code: m.code || null, kpd: m.kpd || null,
      salePrice: sale && sale > 0 ? sale : null, rentPrice: rent && rent > 0 ? rent : null, marginPct: ctx.num(m.marginPct, where, 'marža', null),
      warrantyMonths: ctx.int(m.warrantyMonths, where, 'jamstvo', 0, 600), minStock: ctx.int(m.minStock, where, 'min. zaliha', 0, 1_000_000) ?? 0,
      specs: specs || null, active: m.active !== false, cpu: cleanSpec(m.cpu), screen: cleanSpec(m.screen), os: cleanSpec(m.os),
    });
  }
  mapStatuses(ctx, rows(ctx, db, 'statuses', legacyStatus));
  const svcByName = new Map<string, Key>();
  for (const [i, s] of rows(ctx, db, 'services', legacyService).entries()) {
    const name = s.name || `Usluga ${i + 1}`;
    const prev = svcByName.get(name.toLowerCase());
    const key = prev ?? s.id ?? ctx.genKey('service');
    if (s.id) ctx.services.set(s.id, key);
    if (prev) continue;
    svcByName.set(name.toLowerCase(), key);
    ctx.serviceNames.set(key, name);
    plan.services.push({ key, name, unit: s.unit || 'kom', price: ctx.money(s.price, `Usluga ${name}`, 'cijena', 0), kpd: s.kpd || null, active: s.active !== false });
  }
  for (const [i, p] of rows(ctx, db, 'partners', legacyPartner).entries()) {
    const key = p.id ?? ctx.genKey('partner');
    if (p.id && ctx.partners.has(p.id)) {
      ctx.w.warn('dup-id', 'partner', `Partner „${p.name}": id se ponavlja — drugi zapis preskočen.`);
      continue;
    }
    const country = countryOf(ctx, p);
    const name = p.name || `Partner ${i + 1}`;
    plan.partners.push({
      key, name, oib: p.oib || null, vatId: p.vatId || null, address: p.address || null, zip: p.zip || null, city: p.city || null, country,
      email: p.email || null, phone: p.phone || null, iban: p.iban || null, contactPerson: p.contactPerson || p.contact || null,
      isCustomer: p.isCustomer ?? !p.isSupplier, isSupplier: !!p.isSupplier, excluded: !!p.excluded,
      paymentTermDays: ctx.int(p.paymentTermDays ?? p.paymentDays, `Partner ${name}`, 'rok plaćanja', 0, 365), note: p.note || null,
    });
    ctx.partnerCountry.set(key, country);
    if (p.id) ctx.partners.set(p.id, key);
  }
  const agreements = new Map<string, number>();
  for (const pl of rows(ctx, db, 'priceLists', legacyPriceList)) {
    const partnerKey = pl.partnerId ? ctx.partners.get(pl.partnerId) : undefined;
    const modelKey = pl.modelId ? ctx.models.get(pl.modelId) : undefined;
    if (!partnerKey || !modelKey) {
      ctx.w.warn('ref-price', 'veza', `Dogovorena cijena „${pl.id ?? ''}": partner ili model ne postoji — izostavljena.`);
      continue;
    }
    const sale = ctx.money(pl.salePrice ?? pl.price, 'Dogovorena cijena', 'prodajna', null);
    const rent = ctx.money(pl.rentPrice ?? pl.rentMonthly ?? pl.rent, 'Dogovorena cijena', 'najam', null);
    const row = { partnerKey, modelKey, salePrice: sale && sale > 0 ? sale : null, rentPrice: rent && rent > 0 ? rent : null };
    const k = `${partnerKey}|${modelKey}`;
    if (agreements.has(k)) {
      plan.priceAgreements[agreements.get(k)!] = row;
      ctx.w.info('merge', 'cjenik', 'Dogovorena cijena za isti par partner–model se ponavlja — zadržana zadnja.');
    } else {
      agreements.set(k, plan.priceAgreements.length);
      plan.priceAgreements.push(row);
    }
  }
  for (const e of plan.expenseCategories) ctx.expenseCategories.set(e.name.toLowerCase(), e.key);

  mapItems(ctx, rows(ctx, db, 'items', legacyItem));
  mapContracts(ctx, rows(ctx, db, 'contracts', legacyContract));
  mapInvoices(ctx, rows(ctx, db, 'invoices', legacyInvoice));
  linkItemInvoices(ctx);
  applySalePrices(ctx);
  mapRent(ctx, db.rent);
  mapQuotes(ctx, rows(ctx, db, 'quotes', legacyQuote));
  mapOrders(ctx, rows(ctx, db, 'orders', legacyOrder));
  const receiptExpenses = mapReceipts(ctx, rows(ctx, db, 'receipts', legacyReceipt));
  mapTransfers(ctx, rows(ctx, db, 'transfers', legacyTransfer));
  mapRma(ctx, rows(ctx, db, 'rma', legacyRma));
  const inboundExpenses = mapInbound(ctx, rows(ctx, db, 'inbound', legacyInbound));
  mapExpenses(ctx, rows(ctx, db, 'expenses', legacyExpense), { receipts: receiptExpenses, inbound: inboundExpenses });
  mapAudit(ctx, rows(ctx, db, 'audit', legacyAudit));
  mapPackages(ctx, rows(ctx, db, 'packages', legacyPackage));
  for (const k of ['receiveRequests', 'statusRequests']) {
    if (Array.isArray(db[k]) && (db[k] as unknown[]).length) ctx.w.info('requests', 'zahtjevi', `Zahtjevi na čekanju (${k}) nisu uvezeni — otvorite ih ponovno u novoj verziji.`);
  }

  if (!plan.warehouses.length) ctx.defaultWarehouse();
  for (const it of plan.items) normalizeItemState(it);
  computeInvoiceTotals(plan.invoices);
  plan.counters = ctx.numbers.counters();
  return { plan, notes: det.notes };
}
