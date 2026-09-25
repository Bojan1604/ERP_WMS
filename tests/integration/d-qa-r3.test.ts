/**
 * QA krug 3 (t5 + nabava): knjigovođa bez prava `costs` (iznosi i prilozi računa za robu),
 * otpis u izvještaju troškova, najam na popisu uređaja partnera, novi nalog za popravljen
 * uređaj koji čeka povrat i vrsta na portalu, preplata na popisu partnera, pretraga bez
 * nadzorne ploče, brisanje računa s narudžbenice, skupna provjera troška robe.
 *   npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { accountantAccess, listAccountant } from '../../src/server/queries/accountant';
import { buildAccountantZip } from '../../src/server/queries/accountant-export';
import { expensesByMonth } from '../../src/server/queries/reports/costs';
import { clientSheet } from '../../src/server/queries/client-sheet';
import { attachItems, createContract } from '../../src/server/services/rentals';
import { changeServiceStatus, createServiceOrder, returnDevice } from '../../src/server/services/service';
import { portalDevice } from '../../src/server/portal/queries';
import { partnerStats } from '../../src/server/queries/partners';
import { globalSearch } from '../../src/server/queries/search';
import { createDraft, issueInvoice } from '../../src/server/services/invoices';
import { receiveGoods, saveOrder, setOrderStatus } from '../../src/server/services/purchasing';
import { deleteSupplierInvoice, saveOrderInvoice } from '../../src/server/services/supplier-invoices';
import { goodsExpenseMismatches, reconcileGoodsExpensesChunked } from '../../src/server/services/goods-expense';
import { getSupplierInvoice } from '../../src/server/queries/purchasing';
import { readAccountantFilters } from '../../src/domain/accountant';
import { portalDeviceKind } from '../../src/domain/portal';
import { resolvePermissions } from '../../src/domain/permissions';
import { DomainError } from '../../src/server/errors';
import { addMonths, fromISO, today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup(items = 2) {
  const c = await db.company.create({ data: { name: `D-QA3 ${Date.now()}-${Math.random()}`, oib: '12345678903', invoicePremises: 'K1', vatRegistered: true } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `d3${Date.now()}${Math.random()}@t.hr`, name: 'Tester', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20, warrantyMonths: 24 } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530' } });
  const supplier = await db.partner.create({ data: { companyId: c.id, name: 'Dobavljač d.o.o.', oib: '94577403194', isSupplier: true } });
  const inStock = (await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'))).id;
  const sold = (await transaction((tx) => statusFor(tx, c.id, 'SOLD'))).id;
  const list: Array<{ id: string }> = [];
  for (let i = 0; i < items; i++) {
    list.push(
      await db.item.create({
        data: { companyId: c.id, serial: `D3SN${i}-${Math.random().toString(36).slice(2, 7)}`, modelId: model.id, statusId: inStock, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2026-01-01') },
      }),
    );
  }
  const markSold = (i: number) =>
    db.item.update({ where: { id: list[i].id }, data: { state: 'SOLD', statusId: sold, partnerId: partner.id, warehouseId: null, issueDate: fromISO('2026-01-10') } });
  return { companyId: c.id, actor, model, wh, partner, supplier, items: list, markSold };
}

before(async () => {
  await db.$connect();
});

after(async () => {
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    await db.purchaseOrder.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

const noCost = () => resolvePermissions('ACCOUNTANT', { costs: 'none' });

test('1: knjigovođa bez prava costs — iznosi računa za robu skriveni, zbrojevi bez njih, prilozi ne idu u ZIP', async () => {
  const s = await setup(0);
  const F = readAccountantFilters({ od: '2026-03-01', do: '2026-03-31' });
  const goods = await db.supplierInvoice.create({
    data: { companyId: s.companyId, internalNo: 'URA-1', number: 'R-1/2026', supplierId: s.supplier.id, issueDate: fromISO('2026-03-05'), netAmount: 800, vatAmount: 200, total: 1000, goodsInvoice: true },
  });
  const service = await db.supplierInvoice.create({
    data: { companyId: s.companyId, internalNo: 'URA-2', number: 'R-2/2026', supplierId: s.supplier.id, issueDate: fromISO('2026-03-06'), netAmount: 40, vatAmount: 10, total: 50, goodsInvoice: false },
  });
  for (const id of [goods.id, service.id]) {
    await db.attachment.create({ data: { companyId: s.companyId, entity: 'supplierInvoice', entityId: id, fileName: `${id}.pdf`, mime: 'application/pdf', size: 9, data: Buffer.from('%PDF-1.7\n') } });
  }
  // zadani knjigovođa ima pravo na nabavne cijene
  assert.equal(accountantAccess(resolvePermissions('ACCOUNTANT', {})).costs, true);
  const access = accountantAccess(noCost());
  assert.equal(access.costs, false);

  const full = await listAccountant(s.companyId, F, { out: true, in: true, costs: true });
  assert.equal(full.totals.in.total, 1050);
  const hidden = await listAccountant(s.companyId, F, access);
  const g = hidden.rows.find((r) => r.id === goods.id)!;
  assert.equal(g.net, null);
  assert.equal(g.vat, null);
  assert.equal(g.total, null);
  assert.equal(g.attachments, 0);
  const sv = hidden.rows.find((r) => r.id === service.id)!;
  assert.equal(sv.total, 50);
  assert.equal(hidden.totals.in.count, 2, 'broj dokumenata ostaje pun');
  assert.equal(hidden.totals.in.total, 50, 'zbroj bez računa za robu');
  assert.equal(hidden.totals.inGoodsHidden, true);

  const keys = [`in:${goods.id}`, `in:${service.id}`];
  assert.equal((await buildAccountantZip(s.companyId, keys, undefined, { out: true, in: true, costs: true })).attCount, 2);
  const z = await buildAccountantZip(s.companyId, keys, undefined, access);
  assert.equal(z.attCount, 1, 'prilog računa za robu nije u arhivi');
  const csv = z.rows.find((r) => r.id === goods.id)!;
  assert.equal(csv.total, null, 'popis.csv bez iznosa računa za robu');
});

test('2: troškovi po mjesecima bez prava costs ne prikazuju otpis (isti skup kao popis troškova)', async () => {
  const s = await setup(0);
  const base = { companyId: s.companyId, date: fromISO('2026-03-10'), vatAmount: 0 };
  await db.expense.create({ data: { ...base, description: 'Najam prostora', netAmount: 100, source: 'MANUAL' } });
  await db.expense.create({ data: { ...base, description: 'Otpis opreme', netAmount: 55, source: 'WRITE_OFF' } });
  await db.expense.create({ data: { ...base, description: 'Primka', netAmount: 300, source: 'RECEIPT' } });
  const all = await expensesByMonth(s.companyId, 2026);
  assert.equal(all.total[2], 455);
  const hidden = await expensesByMonth(s.companyId, 2026, { hideCost: true });
  assert.equal(hidden.total[2], 100, 'bez primke i otpisa');
  // profit (s pravom costs): nabava robe se ne oduzima dvaput, otpis ostaje trošak poslovanja
  const profit = await expensesByMonth(s.companyId, 2026, { excludePurchases: true });
  assert.equal(profit.total[2], 155);
});

test('N2: popis uređaja partnera bez prava na najam — bez ugovora, mjesečnog najma i uvjeta', async () => {
  const s = await setup(1);
  const start = addMonths(today(), -1).slice(0, 7) + '-01';
  const c = await transaction((tx) =>
    createContract(tx, s.actor, { startDate: start, endDate: null, firstBillingDate: null, billingDay: 1, billing: 'MONTHLY', billingMode: 'IN_ADVANCE', seasonFrom: null, seasonTo: null, note: null, partnerId: s.partner.id }),
  );
  await transaction((tx) => attachItems(tx, s.actor, c.id, [{ itemId: s.items[0].id, monthly: 25 }], { issueDate: start }));
  const withRent = await clientSheet(s.companyId, s.partner.id, { view: 'najam' });
  assert.equal(withRent!.rows[0].monthly, 25);
  assert.ok(withRent!.rows[0].contract);
  assert.equal(withRent!.monthly, 25);
  assert.equal(withRent!.contracts.length, 1);
  const without = await clientSheet(s.companyId, s.partner.id, { view: 'najam', rentals: false });
  assert.equal(without!.rentals, false);
  assert.equal(without!.rows.length, 1, 'uređaj je i dalje na popisu');
  assert.equal(without!.rows[0].contract, null);
  assert.equal(without!.rows[0].contractId, null);
  assert.equal(without!.rows[0].monthly, null);
  assert.equal(without!.rows[0].price, null);
  assert.equal(without!.monthly, 0);
  assert.deepEqual(without!.contracts, []);
});

test('N3: popravljen uređaj koji je još na servisu ne dobiva novi nalog; portal vrsta prema vlasništvu', async () => {
  const s = await setup(1);
  await s.markSold(0);
  const itemId = s.items[0].id;
  const o = await transaction((tx) => createServiceOrder(tx, s.actor, { itemId, issue: 'Ne pali', reportedAt: today(), status: 'RECEIVED', underWarranty: true, setServiceStatus: true }));
  await transaction((tx) => changeServiceStatus(tx, s.actor, o.id, 'REPAIRED'));
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: itemId } })).state, 'SERVICE');
  await assert.rejects(
    () => transaction((tx) => createServiceOrder(tx, s.actor, { itemId, issue: 'Opet', reportedAt: today(), status: 'REPORTED', underWarranty: true, setServiceStatus: false })),
    (e: unknown) => e instanceof DomainError && /najprije ga vratite/.test(e.message),
  );
  // portal: uređaj na servisu je i dalje „kupnja" (ne naziv statusa „Pokvaren"/„Na servisu")
  const d = await portalDevice({ id: 'x', companyId: s.companyId, partnerId: s.partner.id, name: null, email: 'k@t.hr' }, itemId);
  assert.ok(d);
  assert.equal(d.state, 'SERVICE');
  assert.equal(d.prevState, 'SOLD');
  assert.equal(portalDeviceKind(d.state, d.status.name, d.prevState), 'kupnja');
  // nakon povrata kupcu novi nalog je dopušten
  await transaction((tx) => returnDevice(tx, s.actor, o.id, 'SOLD'));
  const again = await transaction((tx) => createServiceOrder(tx, s.actor, { itemId, issue: 'Opet', reportedAt: today(), status: 'REPORTED', underWarranty: true, setServiceStatus: false }));
  assert.ok(again.number);
});

test('N4: popis partnera vraća preplatu (za povrat) uz otvoreno', async () => {
  const s = await setup(0);
  const id = await transaction(async (tx) => {
    const d = await createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: today(), vatRate: 25, lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 80 }] });
    await issueInvoice(tx, s.actor, d.id);
    return d.id;
  });
  const inv = await db.invoice.findUniqueOrThrow({ where: { id } });
  await db.invoice.update({ where: { id }, data: { paidTotal: Number(inv.grandTotal) + 100, openAmount: 0 } });
  const st = (await partnerStats(s.companyId, [s.partner.id])).get(s.partner.id)!;
  assert.equal(st.open, 0);
  assert.equal(st.overpaid, 100);
});

test('4: globalna pretraga bez nadzorne ploče — samo moduli s pravom', async () => {
  const s = await setup(1);
  const serial = (await db.item.findUniqueOrThrow({ where: { id: s.items[0].id } })).serial;
  const perms = resolvePermissions('WAREHOUSE', { dashboard: 'none', sales: 'none' });
  assert.equal(perms.dashboard, 'none');
  const r = await globalSearch(s.companyId, perms, serial.slice(0, 6));
  assert.ok(r.devices && r.devices.length >= 1, 'uređaji se pretražuju');
  assert.equal(r.invoices, null, 'računi bez prava prodaje se ne pretražuju');
  assert.equal(r.quotes, null);
});

test('brisanje računa nastalog s narudžbenice briše i podatke računa na narudžbenici (ne vraća se sa sljedećom primkom)', async () => {
  const s = await setup(0);
  const o = await transaction((tx) => saveOrder(tx, s.actor, null, { supplierId: s.supplier.id, date: '2026-05-01', lines: [{ modelId: s.model.id, qty: 4, unitCost: 100 }] }));
  await transaction((tx) => setOrderStatus(tx, s.actor, o.id, 'ORDERED'));
  const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { orderId: o.id } });
  const receive = (tag: string) =>
    transaction((tx) =>
      receiveGoods(tx, s.actor, { orderId: o.id, warehouseId: s.wh.id, date: '2026-05-10', bookExpense: true, lines: [{ modelId: s.model.id, unitCost: 100, serials: [`${tag}-${Math.random()}`], orderLineId: line.id }] }),
    );
  await receive('A');
  await transaction((tx) =>
    saveOrderInvoice(tx, s.actor, o.id, {
      supplierInvoiceNo: 'PO-R-9', supplierInvoiceDate: '2026-05-11', supplierInvoiceDueDate: null, supplierInvoiceCurrency: null, supplierInvoiceNet: 400, supplierInvoiceVat: 100, supplierInvoiceTotal: null,
    }),
  );
  const si = await db.supplierInvoice.findFirstOrThrow({ where: { companyId: s.companyId, number: 'PO-R-9' } });
  await transaction((tx) => deleteSupplierInvoice(tx, s.actor, si.id));
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(po.supplierInvoiceNo, null);
  assert.equal(po.supplierInvoiceNet, null);
  await receive('B');
  assert.equal(await db.supplierInvoice.count({ where: { companyId: s.companyId, number: 'PO-R-9' } }), 0, 'račun se ne vraća');
});

test('trošak robe: skupna provjera odstupanja i popravak po skupinama; pregled prihvaćanja povezanog računa', async () => {
  const s = await setup(0);
  const orders: string[] = [];
  for (let k = 0; k < 3; k++) {
    const o = await transaction((tx) => saveOrder(tx, s.actor, null, { supplierId: s.supplier.id, date: '2026-05-01', lines: [{ modelId: s.model.id, qty: 2, unitCost: 100 }] }));
    await transaction((tx) => setOrderStatus(tx, s.actor, o.id, 'ORDERED'));
    const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { orderId: o.id } });
    await transaction((tx) =>
      receiveGoods(tx, s.actor, { orderId: o.id, warehouseId: s.wh.id, date: '2026-05-10', bookExpense: true, lines: [{ modelId: s.model.id, unitCost: 100, serials: [`G${k}-1-${Math.random()}`, `G${k}-2-${Math.random()}`], orderLineId: line.id }] }),
    );
    orders.push(o.id);
  }
  // zaprimljeni eRačun za robu povezan s narudžbenicom (250 € uz primku 200 €): prihvaćanje knjiži samo razliku
  const inbound = await db.supplierInvoice.create({
    data: { companyId: s.companyId, internalNo: 'URA-E1', number: 'E-1', supplierId: s.supplier.id, issueDate: fromISO('2026-05-12'), netAmount: 250, vatAmount: 62.5, total: 312.5, status: 'RECEIVED', source: 'EINVOICE', orderId: orders[0], goodsInvoice: true, category: 'Nabava robe' },
  });
  const view = await getSupplierInvoice(s.companyId, inbound.id);
  assert.deepEqual(
    { linked: view!.acceptPreview!.linked, goods: view!.acceptPreview!.goods, mode: view!.acceptPreview!.mode, ownNet: view!.acceptPreview!.ownNet },
    { linked: true, goods: true, mode: 'partial', ownNet: 50 },
  );
  // stari dvostruko knjiženi računi za robu na dvije narudžbenice
  for (const [k, orderId] of orders.slice(1).entries()) {
    const si = await db.supplierInvoice.create({
      data: { companyId: s.companyId, internalNo: `URA-D${k}`, number: `D-${k}`, supplierId: s.supplier.id, issueDate: fromISO('2026-05-12'), netAmount: 200, vatAmount: 50, total: 250, status: 'ACCEPTED', orderId, goodsInvoice: true, bookExpense: true },
    });
    await db.expense.create({ data: { companyId: s.companyId, date: fromISO('2026-05-12'), description: 'staro', netAmount: 200, vatAmount: 50, source: 'SUPPLIER_INVOICE', supplierInvoiceId: si.id } });
  }
  const mm = await goodsExpenseMismatches(db, s.companyId);
  assert.deepEqual(mm.map((m) => ('orderId' in m.group ? m.group.orderId : '')).sort(), orders.slice(1).sort());
  assert.ok(mm.every((m) => m.booked === 200 && m.expected === 0 && m.label.length > 0 && m.href.startsWith('/nabava/narudzbenice/')));
  assert.equal(await reconcileGoodsExpensesChunked(s.actor, transaction), 2);
  assert.equal((await goodsExpenseMismatches(db, s.companyId)).length, 0);
  assert.equal(await db.auditLog.count({ where: { companyId: s.companyId, action: 'goods-expense-fix' } }), 2);
});
