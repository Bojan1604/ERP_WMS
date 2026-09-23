import 'server-only';
import type { StatusKind } from '@prisma/client';
import type { Tx } from '../db';
import { audit, diff } from '../audit';
import { DomainError, assert } from '../errors';
import type { Actor } from './items';
import { STATUS_KIND_LABEL } from './items';

// ---------------------------------------------------------------- firma

export interface CompanyInput {
  name: string;
  oib: string | null;
  vatId: string | null;
  address: string | null;
  zip: string | null;
  city: string | null;
  country: string;
  iban: string | null;
  bank: string | null;
  email: string | null;
  phone: string | null;
  web: string | null;
  /** undefined = bez promjene, null = ukloni, niz = novi logo (data URL). */
  logo?: string | null;
  currency: string;
  vatRegistered: boolean;
  vatRate: number;
  overdueDays: number;
  paymentTermDays: number;
  quoteValidDays: number;
  defaultMarginPct: number;
  defaultWarrantyMonths: number;
  rentFallbackPct: number;
  invoicePremises: string;
  invoiceDevice: string;
  invoiceSeparator: string;
  invoiceFooter: string | null;
  statusChangeNeedsApproval: boolean;
}

export const MAX_LOGO_BYTES = 300 * 1024;

export async function saveCompany(tx: Tx, actor: Actor, input: CompanyInput) {
  const before = await tx.company.findUniqueOrThrow({ where: { id: actor.companyId } });
  if (input.logo) {
    assert(/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(input.logo), 'Logo mora biti slika (PNG, JPG, GIF, WebP ili SVG).');
    assert(input.logo.length * 0.75 <= MAX_LOGO_BYTES * 1.02, 'Logo je prevelik — najviše 300 KB.');
  }
  assert(input.vatRate >= 0 && input.vatRate <= 100, 'Stopa PDV-a mora biti između 0 i 100.');
  assert(input.defaultMarginPct >= 0 && input.defaultMarginPct < 100, 'Bruto marža mora biti između 0 i 100 %.');
  assert(input.invoicePremises.trim() && input.invoiceDevice.trim(), 'Oznaka poslovnog prostora i naplatnog uređaja su obavezne.');
  assert(!/\s/.test(input.invoicePremises + input.invoiceDevice + input.invoiceSeparator), 'Oznake u broju računa ne smiju imati razmake.');
  const data = {
    ...input,
    country: input.country.toUpperCase().slice(0, 2),
    currency: input.currency.toUpperCase().slice(0, 3),
    oib: input.oib?.replace(/\s+/g, '') || null,
    iban: input.iban?.replace(/\s+/g, '').toUpperCase() || null,
  };
  if (data.logo === undefined) delete data.logo;
  await tx.company.update({ where: { id: actor.companyId }, data });
  const { logo: _l, ...rest } = data;
  const changes = diff(before, rest);
  if (data.logo !== undefined && data.logo !== before.logo) changes.logo = { from: before.logo ? 'slika' : null, to: data.logo ? 'nova slika' : null };
  if (Object.keys(changes).length) {
    await audit(tx, actor, { entity: 'company', entityId: actor.companyId, action: 'update', summary: 'Podaci firme i postavke izmijenjeni', diff: changes as object });
  }
}

// ---------------------------------------------------------------- šifrarnici

/** Ime zapisa za poruke u dnevniku. */
const ENTITY_LABEL = {
  warehouse: 'Skladište',
  category: 'Kategorija',
  model: 'Model',
  status: 'Status',
  service: 'Usluga',
  expenseCategory: 'Kategorija troška',
} as const;
export type LookupEntity = keyof typeof ENTITY_LABEL;

async function logged(tx: Tx, actor: Actor, entity: LookupEntity, id: string, action: string, name: string, changes?: object) {
  await audit(tx, actor, { entity, entityId: id, action, summary: `${ENTITY_LABEL[entity]} „${name}" ${action === 'create' ? 'dodan(a)' : action === 'delete' ? 'obrisan(a)' : 'izmijenjen(a)'}`, diff: changes });
}

export async function saveWarehouse(tx: Tx, actor: Actor, id: string | null, input: { name: string; address: string | null; active: boolean; sort: number }) {
  if (id) {
    const before = await tx.warehouse.findFirst({ where: { id, companyId: actor.companyId } });
    assert(before, 'Skladište ne postoji.');
    if (!input.active && before.active) {
      const n = await tx.item.count({ where: { companyId: actor.companyId, warehouseId: id, state: 'IN_STOCK' } });
      assert(!n, `Na skladištu je još ${n} uređaja — premjestite ih prije deaktivacije.`);
    }
    await tx.warehouse.update({ where: { id }, data: input });
    await logged(tx, actor, 'warehouse', id, 'update', input.name, diff(before, input));
    return id;
  }
  const w = await tx.warehouse.create({ data: { ...input, companyId: actor.companyId } });
  await logged(tx, actor, 'warehouse', w.id, 'create', w.name);
  return w.id;
}

export async function saveCategory(tx: Tx, actor: Actor, id: string | null, input: { name: string; sort: number }) {
  if (id) {
    const before = await tx.category.findFirst({ where: { id, companyId: actor.companyId } });
    assert(before, 'Kategorija ne postoji.');
    await tx.category.update({ where: { id }, data: input });
    await logged(tx, actor, 'category', id, 'update', input.name, diff(before, input));
    return id;
  }
  const c = await tx.category.create({ data: { ...input, companyId: actor.companyId } });
  await logged(tx, actor, 'category', c.id, 'create', c.name);
  return c.id;
}

export interface ModelInput {
  brand: string | null;
  name: string;
  code: string | null;
  categoryId: string | null;
  kpd: string | null;
  salePrice: number | null;
  rentPrice: number | null;
  marginPct: number | null;
  warrantyMonths: number | null;
  minStock: number;
  specs: string | null;
  active: boolean;
}

export async function saveModel(tx: Tx, actor: Actor, id: string | null, input: ModelInput, opts: { applyRent?: boolean } = {}) {
  if (input.categoryId) {
    const c = await tx.category.findFirst({ where: { id: input.categoryId, companyId: actor.companyId }, select: { id: true } });
    assert(c, 'Kategorija ne postoji.');
  }
  assert(input.marginPct === null || (input.marginPct >= 0 && input.marginPct < 100), 'Marža mora biti između 0 i 100 %.');
  assert(input.minStock >= 0, 'Minimalna zaliha ne može biti negativna.');
  const label = [input.brand, input.name].filter(Boolean).join(' ');
  let modelId = id;
  let oldRent: number | null = null;
  if (id) {
    const before = await tx.deviceModel.findFirst({ where: { id, companyId: actor.companyId } });
    assert(before, 'Model ne postoji.');
    oldRent = before.rentPrice === null ? null : before.rentPrice.toNumber();
    await tx.deviceModel.update({ where: { id }, data: input });
    await logged(tx, actor, 'model', id, 'update', label, diff(before, { ...input }));
  } else {
    const m = await tx.deviceModel.create({ data: { ...input, companyId: actor.companyId } });
    modelId = m.id;
    await logged(tx, actor, 'model', m.id, 'create', label);
  }
  let applied = 0;
  if (opts.applyRent && input.rentPrice !== null && modelId) {
    // uređaji bez vlastite cijene najma (prazno ili preuzeto sa starog cjenika modela);
    // uređaji na ugovoru zadržavaju ugovorenu mjesečnu cijenu (ContractItem.monthly)
    const r = await tx.item.updateMany({
      where: { companyId: actor.companyId, modelId, OR: [{ rentPrice: null }, ...(oldRent !== null ? [{ rentPrice: oldRent }] : [])] },
      data: { rentPrice: input.rentPrice },
    });
    applied = r.count;
    if (applied) {
      await audit(tx, actor, { entity: 'model', entityId: modelId, action: 'rent-apply', summary: `Najam ${input.rentPrice} primijenjen na ${applied} uređaja modela ${label}` });
    }
  }
  return { id: modelId!, applied };
}

export async function saveStatus(tx: Tx, actor: Actor, id: string | null, input: { name: string; kind: StatusKind; color: string; sort: number }) {
  if (id) {
    const before = await tx.itemStatus.findFirst({ where: { id, companyId: actor.companyId } });
    assert(before, 'Status ne postoji.');
    if (before.system && before.kind !== input.kind) {
      throw new DomainError(`„${before.name}" je sistemski status vrste „${STATUS_KIND_LABEL[before.kind]}" — vrsta mu se ne može mijenjati (naziv i boja mogu).`);
    }
    if (before.kind !== input.kind) {
      const n = await tx.item.count({ where: { companyId: actor.companyId, statusId: id } });
      assert(!n, `Status ima ${n} uređaja — vrsta se ne može promijeniti dok su uređaji u njemu (promjena statusa ide kroz skladište).`);
    }
    await tx.itemStatus.update({ where: { id }, data: input });
    await logged(tx, actor, 'status', id, 'update', input.name, diff(before, input));
    return id;
  }
  const s = await tx.itemStatus.create({ data: { ...input, companyId: actor.companyId, system: false } });
  await logged(tx, actor, 'status', s.id, 'create', s.name);
  return s.id;
}

export async function saveService(tx: Tx, actor: Actor, id: string | null, input: { name: string; unit: string; price: number; kpd: string | null; active: boolean }) {
  if (id) {
    const before = await tx.service.findFirst({ where: { id, companyId: actor.companyId } });
    assert(before, 'Usluga ne postoji.');
    await tx.service.update({ where: { id }, data: input });
    await logged(tx, actor, 'service', id, 'update', input.name, diff(before, input));
    return id;
  }
  const s = await tx.service.create({ data: { ...input, companyId: actor.companyId } });
  await logged(tx, actor, 'service', s.id, 'create', s.name);
  return s.id;
}

export async function saveExpenseCategory(tx: Tx, actor: Actor, id: string | null, input: { name: string }) {
  if (id) {
    const before = await tx.expenseCategory.findFirst({ where: { id, companyId: actor.companyId } });
    assert(before, 'Kategorija troška ne postoji.');
    await tx.expenseCategory.update({ where: { id }, data: input });
    await logged(tx, actor, 'expenseCategory', id, 'update', input.name, diff(before, input));
    return id;
  }
  const c = await tx.expenseCategory.create({ data: { ...input, companyId: actor.companyId } });
  await logged(tx, actor, 'expenseCategory', c.id, 'create', c.name);
  return c.id;
}

/** Brisanje zapisa šifrarnika — samo kad ga ništa ne koristi. */
export async function deleteLookup(tx: Tx, actor: Actor, entity: LookupEntity, id: string) {
  const c = actor.companyId;
  const block = (n: number, what: string, hint = '') => {
    if (n > 0) throw new DomainError(`Ne može se obrisati — koristi ga ${n} ${what}.${hint}`);
  };
  switch (entity) {
    case 'warehouse': {
      const w = await tx.warehouse.findFirst({ where: { id, companyId: c }, select: { name: true, _count: { select: { items: true, receipts: true, transfersFrom: true, transfersTo: true } } } });
      assert(w, 'Skladište ne postoji.');
      block(w._count.items, 'uređaja', ' Deaktivirajte ga umjesto brisanja.');
      block(w._count.receipts + w._count.transfersFrom + w._count.transfersTo, 'dokumenata (primke, međuskladišnice)', ' Deaktivirajte ga umjesto brisanja.');
      await tx.warehouse.delete({ where: { id } });
      return logged(tx, actor, entity, id, 'delete', w.name);
    }
    case 'category': {
      const k = await tx.category.findFirst({ where: { id, companyId: c }, select: { name: true, _count: { select: { models: true } } } });
      assert(k, 'Kategorija ne postoji.');
      block(k._count.models, 'modela', ' Prvo modelima promijenite kategoriju.');
      await tx.category.delete({ where: { id } });
      return logged(tx, actor, entity, id, 'delete', k.name);
    }
    case 'model': {
      const m = await tx.deviceModel.findFirst({
        where: { id, companyId: c },
        select: { brand: true, name: true, _count: { select: { items: true, invoiceLines: true, quoteLines: true, orderLines: true, priceAgreements: true } } },
      });
      assert(m, 'Model ne postoji.');
      const hint = ' Deaktivirajte ga — neće se nuditi pri unosu, a povijest ostaje.';
      block(m._count.items, 'uređaja', hint);
      block(m._count.invoiceLines + m._count.quoteLines + m._count.orderLines, 'stavki dokumenata', hint);
      block(m._count.priceAgreements, 'dogovorenih cijena partnera', hint);
      await tx.deviceModel.delete({ where: { id } });
      return logged(tx, actor, entity, id, 'delete', [m.brand, m.name].filter(Boolean).join(' '));
    }
    case 'status': {
      const s = await tx.itemStatus.findFirst({ where: { id, companyId: c }, select: { name: true, system: true, _count: { select: { items: true } } } });
      assert(s, 'Status ne postoji.');
      assert(!s.system, `„${s.name}" je sistemski status — program ga koristi i ne može se obrisati (može se preimenovati).`);
      block(s._count.items, 'uređaja', ' Prvo im promijenite status.');
      await tx.itemStatus.delete({ where: { id } });
      return logged(tx, actor, entity, id, 'delete', s.name);
    }
    case 'service': {
      const s = await tx.service.findFirst({ where: { id, companyId: c }, select: { name: true, _count: { select: { lines: true, quoteLines: true } } } });
      assert(s, 'Usluga ne postoji.');
      block(s._count.lines + s._count.quoteLines, 'stavki računa i ponuda', ' Deaktivirajte je umjesto brisanja.');
      await tx.service.delete({ where: { id } });
      return logged(tx, actor, entity, id, 'delete', s.name);
    }
    case 'expenseCategory': {
      const e = await tx.expenseCategory.findFirst({ where: { id, companyId: c }, select: { name: true, _count: { select: { expenses: true } } } });
      assert(e, 'Kategorija troška ne postoji.');
      block(e._count.expenses, 'troškova', ' Prvo troškovima promijenite kategoriju.');
      await tx.expenseCategory.delete({ where: { id } });
      return logged(tx, actor, entity, id, 'delete', e.name);
    }
  }
}
