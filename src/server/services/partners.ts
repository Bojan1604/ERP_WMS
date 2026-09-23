import 'server-only';
import type { Tx } from '../db';
import { audit, diff } from '../audit';
import { DomainError, assert } from '../errors';
import type { Actor } from './items';

export interface PartnerInput {
  name: string;
  oib: string | null;
  vatId: string | null;
  address: string | null;
  zip: string | null;
  city: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  iban: string | null;
  contactPerson: string | null;
  isCustomer: boolean;
  isSupplier: boolean;
  excluded: boolean;
  paymentTermDays: number | null;
  note: string | null;
}

export async function savePartner(tx: Tx, actor: Actor, id: string | null, input: PartnerInput) {
  const data = {
    ...input,
    country: (input.country || 'HR').toUpperCase().slice(0, 2),
    oib: input.oib?.replace(/\s+/g, '') || null,
    iban: input.iban?.replace(/\s+/g, '').toUpperCase() || null,
  };
  assert(data.isCustomer || data.isSupplier, 'Partner mora biti kupac, dobavljač ili oboje.');
  if (data.oib) {
    const dup = await tx.partner.findFirst({ where: { companyId: actor.companyId, oib: data.oib, ...(id ? { id: { not: id } } : {}) }, select: { name: true } });
    assert(!dup, `Partner s OIB-om ${data.oib} već postoji: ${dup?.name}.`);
  }
  if (id) {
    const before = await tx.partner.findFirst({ where: { id, companyId: actor.companyId } });
    assert(before, 'Partner ne postoji.');
    await tx.partner.update({ where: { id }, data });
    const changes = diff(before, data);
    if (Object.keys(changes).length) {
      await audit(tx, actor, {
        entity: 'partner',
        entityId: id,
        action: 'update',
        summary: `Partner ${data.name} izmijenjen${before.excluded !== data.excluded ? (data.excluded ? ' — isključen iz obračuna' : ' — vraćen u obračun') : ''}`,
        diff: changes as object,
      });
    }
    return id;
  }
  const p = await tx.partner.create({ data: { ...data, companyId: actor.companyId } });
  await audit(tx, actor, { entity: 'partner', entityId: p.id, action: 'create', summary: `Novi partner ${p.name}` });
  return p.id;
}

/** Brisanje samo ako partner nema nijedan dokument ni uređaj; inače se predlaže isključivanje. */
export async function deletePartner(tx: Tx, actor: Actor, id: string) {
  const p = await tx.partner.findFirst({
    where: { id, companyId: actor.companyId },
    select: {
      name: true,
      _count: {
        select: {
          invoices: true, quotes: true, contracts: true, orders: true, receipts: true, supplierInvoices: true,
          serviceOrders: true, expenses: true, heldItems: true, suppliedItems: true,
        },
      },
    },
  });
  assert(p, 'Partner ne postoji.');
  const c = p._count;
  const refs = [
    [c.invoices, 'računa'], [c.quotes, 'ponuda'], [c.contracts, 'ugovora'], [c.orders, 'narudžbenica'], [c.receipts, 'primki'],
    [c.supplierInvoices, 'ulaznih računa'], [c.serviceOrders, 'servisnih naloga'], [c.expenses, 'troškova'],
    [c.heldItems + c.suppliedItems, 'uređaja'],
  ].filter(([n]) => (n as number) > 0);
  if (refs.length) {
    throw new DomainError(
      `Partner ${p.name} ima ${refs.map(([n, l]) => `${n} ${l}`).join(', ')} i ne može se obrisati. Ako ga ne želite u obračunu, označite ga kao isključenog.`,
    );
  }
  await tx.partner.delete({ where: { id } });
  await audit(tx, actor, { entity: 'partner', entityId: id, action: 'delete', summary: `Obrisan partner ${p.name}` });
}

export async function savePriceAgreement(
  tx: Tx,
  actor: Actor,
  input: { id: string | null; partnerId: string; modelId: string; salePrice: number | null; rentPrice: number | null },
) {
  const [partner, model] = await Promise.all([
    tx.partner.findFirst({ where: { id: input.partnerId, companyId: actor.companyId }, select: { name: true } }),
    tx.deviceModel.findFirst({ where: { id: input.modelId, companyId: actor.companyId }, select: { brand: true, name: true } }),
  ]);
  assert(partner, 'Partner ne postoji.');
  assert(model, 'Model ne postoji.');
  assert(input.salePrice !== null || input.rentPrice !== null, 'Upišite prodajnu cijenu, najam ili oboje.');
  assert((input.salePrice ?? 0) >= 0 && (input.rentPrice ?? 0) >= 0, 'Cijena ne može biti negativna.');
  const data = { salePrice: input.salePrice, rentPrice: input.rentPrice };
  const label = [model.brand, model.name].filter(Boolean).join(' ');
  if (input.id) {
    const row = await tx.priceAgreement.findFirst({ where: { id: input.id, companyId: actor.companyId, partnerId: input.partnerId } });
    assert(row, 'Dogovorena cijena ne postoji.');
    await tx.priceAgreement.update({ where: { id: input.id }, data: { ...data, modelId: input.modelId } });
  } else {
    const dup = await tx.priceAgreement.findUnique({ where: { partnerId_modelId: { partnerId: input.partnerId, modelId: input.modelId } } });
    assert(!dup, `Za model ${label} već postoji dogovorena cijena — uredite postojeću.`);
    await tx.priceAgreement.create({ data: { ...data, companyId: actor.companyId, partnerId: input.partnerId, modelId: input.modelId } });
  }
  await audit(tx, actor, {
    entity: 'partner',
    entityId: input.partnerId,
    action: 'price',
    summary: `Dogovorena cijena za ${partner.name}: ${label}`,
    diff: data,
  });
}

export async function deletePriceAgreement(tx: Tx, actor: Actor, id: string) {
  const row = await tx.priceAgreement.findFirst({ where: { id, companyId: actor.companyId }, include: { partner: { select: { name: true } }, model: { select: { brand: true, name: true } } } });
  assert(row, 'Dogovorena cijena ne postoji.');
  await tx.priceAgreement.delete({ where: { id } });
  await audit(tx, actor, {
    entity: 'partner',
    entityId: row.partnerId,
    action: 'price-delete',
    summary: `Obrisana dogovorena cijena za ${row.partner.name}: ${[row.model.brand, row.model.name].filter(Boolean).join(' ')}`,
  });
}
