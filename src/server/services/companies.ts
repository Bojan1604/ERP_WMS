import 'server-only';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { audit } from '../audit';
import { DomainError, assert } from '../errors';
import { bootstrapCompany } from './company';
import type { Actor } from './items';
import { isCurrencyCode } from '@/domain/company';

/**
 * Više firmi (F13). `User.companyId` je trenutno odabrana firma; popis firmi
 * kojima korisnik smije pristupiti je u `UserCompany` (plus trenutna). Uloga i
 * prava vrijede u svim firmama. Svi podaci su strogo odvojeni po firmi.
 */

/** Firme kojima korisnik ima pristup (trenutna uvijek). */
export async function accessibleCompanies(tx: Tx, userId: string) {
  const u = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { companyId: true, companies: { select: { company: { select: { id: true, name: true, country: true, currency: true } } } } },
  });
  const list = new Map(u.companies.map((c) => [c.company.id, c.company]));
  if (!list.has(u.companyId)) {
    const cur = await tx.company.findUniqueOrThrow({ where: { id: u.companyId }, select: { id: true, name: true, country: true, currency: true } });
    list.set(cur.id, cur);
  }
  return [...list.values()].sort((a, b) => a.name.localeCompare(b.name, 'hr'));
}

export async function hasAccess(tx: Tx, userId: string, companyId: string) {
  const n = await tx.user.count({ where: { id: userId, OR: [{ companyId }, { companies: { some: { companyId } } }] } });
  return n > 0;
}

/**
 * Prebacivanje u drugu firmu: samo u firmu kojoj korisnik ima pristup. Trenutna
 * firma se upisuje u popis (da se može vratiti). Djeluje na sve sesije korisnika.
 */
export async function switchCompany(tx: Tx, actor: Actor, companyId: string) {
  if (companyId === actor.companyId) return { name: (await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } })).name };
  assert(await hasAccess(tx, actor.id, companyId), 'Nemate pristup toj firmi.');
  const target = await tx.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
  assert(target, 'Firma ne postoji.');
  await tx.userCompany.createMany({ data: [{ userId: actor.id, companyId: actor.companyId }, { userId: actor.id, companyId }], skipDuplicates: true });
  await tx.user.update({ where: { id: actor.id }, data: { companyId } });
  await audit(tx, actor, { entity: 'company', entityId: companyId, action: 'switch', summary: `Prelazak u firmu „${target.name}"` });
  await audit(tx, { ...actor, companyId }, { entity: 'company', entityId: companyId, action: 'switch', summary: `${actor.name} je prešao u ovu firmu` });
  return { name: target.name };
}

export interface NewCompanyInput {
  name: string;
  country: string;
  currency: string;
  /** Preslikati statuse, kategorije, modele, usluge, skladišta i kategorije troškova iz trenutne firme. */
  copyLookups: boolean;
}

/** Zadana stopa PDV-a po državi (mijenja se u postavkama firme). */
const VAT_BY_COUNTRY: Record<string, number> = { HR: 25, RS: 20, BA: 17, SI: 22, ME: 21, MK: 18, AT: 20, DE: 19, IT: 22, HU: 27 };

/** Nova firma (administrator): osnovni šifrarnici kao pri prvoj postavi, po želji preslika šifrarnika trenutne firme. */
export async function createCompany(tx: Tx, actor: Actor, input: NewCompanyInput) {
  const name = input.name.trim();
  assert(name.length >= 2, 'Upišite naziv firme.');
  const country = input.country.trim().toUpperCase();
  assert(/^[A-Z]{2}$/.test(country), 'Država mora biti oznaka od dva slova (npr. HR).');
  const currency = input.currency.trim().toUpperCase();
  assert(isCurrencyCode(currency), 'Valuta mora biti oznaka od tri slova (npr. EUR).');
  const exists = await tx.company.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, OR: [{ id: actor.companyId }, { userCompanies: { some: { userId: actor.id } } }] }, select: { id: true } });
  assert(!exists, `Firma „${name}" već postoji među vašim firmama.`);

  const c = await tx.company.create({ data: { name, country, currency, vatRate: VAT_BY_COUNTRY[country] ?? 25 } });
  if (input.copyLookups) await copyLookups(tx, actor.companyId, c.id);
  // sistemski statusi, zadano skladište i kategorije troškova (preskaču se ako su preslikani)
  await bootstrapCompany(tx, c.id);
  await tx.userCompany.createMany({ data: [{ userId: actor.id, companyId: actor.companyId }, { userId: actor.id, companyId: c.id }], skipDuplicates: true });
  await audit(tx, actor, { entity: 'company', entityId: c.id, action: 'create', summary: `Otvorena nova firma „${name}" (${country}, ${currency})${input.copyLookups ? ' sa šifrarnicima ove firme' : ''}` });
  await audit(tx, { ...actor, companyId: c.id }, { entity: 'company', entityId: c.id, action: 'create', summary: `Firma otvorena (${actor.name})` });
  return c;
}

/** Preslika šifrarnika: statusi, kategorije, modeli, usluge, skladišta, kategorije troškova (bez uređaja i dokumenata). */
async function copyLookups(tx: Tx, from: string, to: string) {
  const [statuses, categories, models, services, warehouses, expenseCategories] = await Promise.all([
    tx.itemStatus.findMany({ where: { companyId: from } }),
    tx.category.findMany({ where: { companyId: from } }),
    tx.deviceModel.findMany({ where: { companyId: from } }),
    tx.service.findMany({ where: { companyId: from } }),
    tx.warehouse.findMany({ where: { companyId: from } }),
    tx.expenseCategory.findMany({ where: { companyId: from } }),
  ]);
  const strip = <T extends { id: string; companyId: string }>(r: T) => {
    const { id: _id, companyId: _c, ...rest } = r;
    return rest;
  };
  await tx.itemStatus.createMany({ data: statuses.map((s) => ({ ...strip(s), companyId: to })), skipDuplicates: true });
  await tx.warehouse.createMany({ data: warehouses.map((w) => ({ ...strip(w), companyId: to })), skipDuplicates: true });
  await tx.expenseCategory.createMany({ data: expenseCategories.map((e) => ({ ...strip(e), companyId: to })), skipDuplicates: true });
  await tx.service.createMany({ data: services.map((s) => ({ ...strip(s), companyId: to })), skipDuplicates: true });
  const catMap = new Map<string, string>();
  for (const k of categories) {
    const n = await tx.category.create({ data: { ...strip(k), companyId: to } });
    catMap.set(k.id, n.id);
  }
  await tx.deviceModel.createMany({
    data: models.map((m) => ({ ...(strip(m) as Omit<typeof m, 'id' | 'companyId'>), companyId: to, categoryId: m.categoryId ? (catMap.get(m.categoryId) ?? null) : null })) as Prisma.DeviceModelCreateManyInput[],
    skipDuplicates: true,
  });
}

/** Administrator daje ili oduzima korisniku pristup firmi (obje firme moraju biti administratorove). */
export async function setCompanyAccess(tx: Tx, actor: Actor, userId: string, companyId: string, grant: boolean) {
  assert(await hasAccess(tx, actor.id, companyId), 'Nemate pristup toj firmi.');
  const u = await tx.user.findFirst({ where: { id: userId, OR: [{ companyId: actor.companyId }, { companies: { some: { companyId: actor.companyId } } }] }, select: { id: true, name: true, companyId: true, role: true } });
  assert(u, 'Korisnik ne postoji.');
  assert(u.role !== 'DISTRIBUTOR' && u.role !== 'CLIENT', 'Vanjski korisnici MDM-a pripadaju jednoj firmi.');
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });
  if (grant) {
    await tx.userCompany.createMany({ data: [{ userId, companyId: u.companyId }, { userId, companyId }], skipDuplicates: true });
  } else {
    if (u.companyId === companyId) throw new DomainError(`${u.name} trenutno radi u firmi „${company.name}" — pristup se može oduzeti kad prijeđe u drugu firmu.`);
    await tx.userCompany.deleteMany({ where: { userId, companyId } });
  }
  await audit(tx, actor, { entity: 'user', entityId: userId, action: grant ? 'company-grant' : 'company-revoke', summary: `${u.name}: ${grant ? 'dodan pristup' : 'oduzet pristup'} firmi „${company.name}"` });
}

/** Zapisi koji firmu čine „nepraznom" (brisanje firme dopušteno samo bez njih — ili nakon „Obriši sve" u opasnoj zoni). */
export async function companyUsage(tx: Tx, companyId: string) {
  const w = { companyId };
  const [items, invoices, partners, contracts, quotes, expenses, supplierInvoices, serviceOrders, purchaseOrders, receipts, transfers] = await Promise.all([
    tx.item.count({ where: w }), tx.invoice.count({ where: w }), tx.partner.count({ where: w }), tx.contract.count({ where: w }),
    tx.quote.count({ where: w }), tx.expense.count({ where: w }), tx.supplierInvoice.count({ where: w }), tx.serviceOrder.count({ where: w }),
    tx.purchaseOrder.count({ where: w }), tx.goodsReceipt.count({ where: w }), tx.transfer.count({ where: w }),
  ]);
  return { items, invoices, partners, contracts, quotes, expenses, supplierInvoices, serviceOrders, purchaseOrders, receipts, transfers };
}

/**
 * Brisanje firme: samo prazne (bez uređaja, dokumenata i partnera), ne one u
 * kojoj administrator trenutno radi, i ne ako bi neki korisnik ostao bez firme.
 */
export async function deleteCompany(tx: Tx, actor: Actor, companyId: string, confirmName: string) {
  assert(companyId !== actor.companyId, 'Ne možete obrisati firmu u kojoj trenutno radite — prijeđite u drugu firmu.');
  assert(await hasAccess(tx, actor.id, companyId), 'Nemate pristup toj firmi.');
  const c = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });
  assert(confirmName.trim() === c.name, 'Upisani naziv ne odgovara nazivu firme.');
  const usage = await companyUsage(tx, companyId);
  const used = Object.entries(usage).filter(([, n]) => n > 0);
  if (used.length) {
    throw new DomainError(`Firma „${c.name}" nije prazna (${used.map(([k, n]) => `${n} ${USAGE_LABEL[k as keyof typeof usage]}`).join(', ')}). Obrišite podatke u opasnoj zoni te firme („Obriši sve") pa je obrišite.`);
  }
  // korisnici kojima je to trenutna firma prelaze u drugu dostupnu; bez druge — brisanje nije moguće
  const home = await tx.user.findMany({ where: { companyId }, select: { id: true, name: true, companies: { where: { companyId: { not: companyId } }, select: { companyId: true }, take: 1 } } });
  const stuck = home.filter((u) => !u.companies.length);
  assert(!stuck.length, `Korisnici ${stuck.map((u) => u.name).join(', ')} nemaju drugu firmu — dodijelite im pristup drugoj firmi ili ih obrišite.`);
  for (const u of home) await tx.user.update({ where: { id: u.id }, data: { companyId: u.companies[0].companyId } });
  await tx.userCompany.deleteMany({ where: { companyId } });
  await tx.company.delete({ where: { id: companyId } });
  await audit(tx, actor, { entity: 'company', entityId: companyId, action: 'delete', summary: `Obrisana firma „${c.name}"` });
}

const USAGE_LABEL = {
  items: 'uređaja', invoices: 'računa', partners: 'partnera', contracts: 'ugovora', quotes: 'ponuda', expenses: 'troškova',
  supplierInvoices: 'ulaznih računa', serviceOrders: 'servisnih naloga', purchaseOrders: 'narudžbenica', receipts: 'primki', transfers: 'međuskladišnica',
} as const;
