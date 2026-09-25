/**
 * Zajednička priprema za integracijske testove područja F (postavke, izvještaji,
 * sigurnost, sustav). Svaki test radi u vlastitoj firmi; `cleanup()` ih briše.
 */
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { fromISO } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');
process.env.AUTH_SECRET ??= 'test-secret-test-secret-test-secret-123456';

export const companies: string[] = [];
const uniq = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

export async function setupCompany(opts: { items?: number; name?: string } = {}) {
  const c = await db.company.create({ data: { name: opts.name ?? `F test ${uniq()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `f${uniq()}@t.hr`, name: 'Tester', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const category = await db.category.create({ data: { companyId: c.id, name: 'POS' } });
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20, categoryId: category.id } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.' } });
  const supplier = await db.partner.create({ data: { companyId: c.id, name: 'Dobavljač d.o.o.', isSupplier: true, isCustomer: false } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const items = [];
  for (let i = 0; i < (opts.items ?? 6); i++) {
    items.push(
      await db.item.create({
        data: {
          companyId: c.id, serial: `SN${i}`, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, supplierId: supplier.id,
          cost: 100, importDate: fromISO('2026-01-15'),
        },
      }),
    );
  }
  return { companyId: c.id, company: c, user: u, actor, model, category, wh, partner, supplier, items };
}

/** Briše testne firme (sve kaskadno) i korisnike koji su u njima. */
export async function cleanup() {
  const { deleteTransactions } = await import('../../src/server/services/danger');
  for (const id of companies) {
    // promet redom stranih ključeva (RESTRICT na modelima/skladištima), zatim firma kaskadno
    if (await db.company.findUnique({ where: { id }, select: { id: true } })) {
      await db.$transaction((tx) => deleteTransactions(tx, { id: 'test', name: 'test', companyId: id }), { timeout: 60_000 });
    }
    await db.userCompany.deleteMany({ where: { companyId: id } });
    await db.user.deleteMany({ where: { companyId: id } });
    await db.company.deleteMany({ where: { id } });
  }
  companies.length = 0;
}
