import 'server-only';
import type { Tx } from '../db';
import { assert } from '../errors';
import { audit } from '../audit';
import type { Actor } from './items';
import { saveQuote } from './quotes';
import { createDraft } from './invoices';
import { customerVat } from '@/domain/tax';
import { addDays, today } from '@/domain/dates';
import { num } from '@/domain/money';
import { distributePackagePrice } from '@/domain/pricing';

/**
 * Paketi (Marže → Paketi): skupina uređaja sa skladišta s cijenom paketa i
 * ukupnom maržom. Paket je informativan — iz njega se izrađuje ponuda, predračun
 * ili nacrt računa za kupca; cijena paketa se raspoređuje na uređaje razmjerno
 * preporučenim cijenama (`distributePackagePrice`).
 */
export interface PackageInput {
  name: string;
  itemIds: string[];
  /** Cijena paketa (neto); null = zbroj preporučenih cijena. */
  price: number | null;
  note: string | null;
}

export type PackageTarget = 'QUOTE' | 'PROFORMA' | 'INVOICE';

const available = (i: { state: string; contractItem: unknown }) => (i.state === 'IN_STOCK' || i.state === 'RESERVED') && !i.contractItem;

/** Uređaji paketa moraju biti firme i na skladištu (ne prodani, ne na ugovoru). */
async function checkItems(tx: Tx, actor: Actor, itemIds: string[]) {
  assert(itemIds.length > 0, 'Dodajte barem jedan uređaj.');
  assert(new Set(itemIds).size === itemIds.length, 'Isti uređaj je dvaput u paketu.');
  const items = await tx.item.findMany({
    where: { id: { in: itemIds }, companyId: actor.companyId },
    select: { id: true, serial: true, state: true, contractItem: { select: { id: true } } },
  });
  assert(items.length === itemIds.length, 'Neki uređaji ne postoje.');
  const gone = items.filter((i) => !available(i));
  assert(!gone.length, `Uređaji više nisu na skladištu: ${gone.map((i) => i.serial).join(', ')} — maknite ih iz paketa.`);
}

/** Novi paket (id = null) ili izmjena postojećeg. */
export async function savePackage(tx: Tx, actor: Actor, id: string | null, input: PackageInput) {
  const name = input.name.trim();
  assert(name, 'Upišite naziv paketa.');
  assert(input.price === null || input.price >= 0, 'Cijena paketa ne može biti negativna.');
  await checkItems(tx, actor, input.itemIds);
  const data = { name, price: input.price, note: input.note?.trim() || null };
  const items = { create: input.itemIds.map((itemId, sort) => ({ itemId, sort })) };
  if (!id) {
    const p = await tx.package.create({ data: { companyId: actor.companyId, ...data, createdBy: actor.name, items } });
    await audit(tx, actor, { entity: 'package', entityId: p.id, action: 'create', summary: `Paket „${name}" (${input.itemIds.length} uređaja)` });
    return p;
  }
  const cur = await tx.package.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true } });
  assert(cur, 'Paket ne postoji.');
  await tx.packageItem.deleteMany({ where: { packageId: id } });
  const p = await tx.package.update({ where: { id }, data: { ...data, items } });
  await audit(tx, actor, { entity: 'package', entityId: id, action: 'update', summary: `Paket „${name}" izmijenjen (${input.itemIds.length} uređaja)` });
  return p;
}

export async function deletePackage(tx: Tx, actor: Actor, id: string) {
  const p = await tx.package.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, name: true } });
  assert(p, 'Paket ne postoji.');
  await tx.package.delete({ where: { id } });
  await audit(tx, actor, { entity: 'package', entityId: id, action: 'delete', summary: `Paket „${p.name}" obrisan` });
}

/** Uređaji paketa redom (za pretvaranje: cijene se računaju za odabranog kupca). */
export async function packageItemIds(tx: Pick<Tx, 'package'>, companyId: string, id: string) {
  const p = await tx.package.findFirst({ where: { id, companyId }, select: { id: true, items: { orderBy: { sort: 'asc' }, select: { itemId: true } } } });
  assert(p, 'Paket ne postoji.');
  return p.items.map((i) => i.itemId);
}

/** Uređaj za pretvaranje: preporučena cijena za kupca (dogovorena → model → marža). */
export interface PackageDevice {
  id: string;
  modelId: string;
  model: string;
  price: number;
  warrantyMonths: number;
  kpd: string | null;
}

/**
 * Paket → ponuda, predračun ili nacrt računa za kupca. `devices` su uređaji paketa
 * s preporučenim cijenama za tog kupca (redoslijed kao u paketu); moraju biti svi.
 */
export async function packageToDocument(tx: Tx, actor: Actor, id: string, partnerId: string, target: PackageTarget, devices: PackageDevice[]) {
  const p = await tx.package.findFirst({
    where: { id, companyId: actor.companyId },
    select: { id: true, name: true, price: true, note: true, items: { orderBy: { sort: 'asc' }, select: { itemId: true } } },
  });
  assert(p, 'Paket ne postoji.');
  assert(p.items.length > 0, 'Paket nema uređaja.');
  const byId = new Map(devices.map((d) => [d.id, d]));
  const missing = p.items.filter((i) => !byId.has(i.itemId));
  assert(!missing.length, `Neki uređaji paketa više nisu na skladištu (${missing.length}) — uredite paket.`);
  await checkItems(tx, actor, p.items.map((i) => i.itemId));
  const [partner, company] = await Promise.all([
    tx.partner.findFirst({ where: { id: partnerId, companyId: actor.companyId }, select: { name: true, country: true, vatCategoryOverride: true } }),
    tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { vatRegistered: true, vatRate: true, country: true, quoteValidDays: true } }),
  ]);
  assert(partner, 'Kupac ne postoji.');
  const list = p.items.map((i) => byId.get(i.itemId)!);
  const prices = distributePackagePrice(list.map((d) => d.price), p.price === null ? null : num(p.price));
  const vat = customerVat(partner, { vatRegistered: company.vatRegistered, vatRate: num(company.vatRate), country: company.country });
  const date = today();
  const note = [`Paket: ${p.name}`, p.note].filter(Boolean).join('\n');

  if (target === 'INVOICE') {
    const inv = await createDraft(tx, actor, {
      type: 'SALE',
      partnerId,
      date,
      // dospijeće računa određuje izdavanje (rok plaćanja kupca od stvarnog datuma računa)
      dueDate: null,
      vatRate: vat.category === 'S' ? vat.rate : 0,
      taxCategory: vat.category,
      taxExemptReason: vat.exemptReason ?? null,
      description: `Paket ${p.name}`,
      note: p.note,
      lines: list.map((d, i) => ({ kind: 'DEVICE', itemId: d.id, modelId: d.modelId, description: d.model, kpd: d.kpd, qty: 1, unitPrice: prices[i], warrantyMonths: d.warrantyMonths, lineType: 'SALE' })),
    });
    await audit(tx, actor, { entity: 'package', entityId: p.id, action: 'convert', summary: `Paket „${p.name}" → nacrt računa za ${partner.name}` });
    return { kind: 'invoice' as const, id: inv.id, number: null };
  }

  const q = await saveQuote(tx, actor, null, {
    kind: target,
    partnerId,
    date,
    validUntil: addDays(date, company.quoteValidDays),
    vatRate: vat.rate,
    note,
    lines: list.map((d, i) => ({ kind: 'DEVICE', itemId: d.id, modelId: d.modelId, description: d.model, qty: 1, unitPrice: prices[i] })),
  });
  await audit(tx, actor, { entity: 'package', entityId: p.id, action: 'convert', summary: `Paket „${p.name}" → ${target === 'PROFORMA' ? 'predračun' : 'ponuda'} ${q.number} za ${partner.name}` });
  return { kind: 'quote' as const, id: q.id, number: q.number };
}
