/**
 * QA t3 — nabava/skladište nad testnom bazom:
 *  #1 prijevoz (drugi račun narudžbenice) nije račun za robu → knjiži se; roba jednom
 *  #2 odluka „račun za robu" se pamti (goodsInvoice) — prihvaćanje eRačuna je poštuje
 *  #3 vlastiti zahtjev za promjenu statusa se ne odobrava
 *  #5 profit po mjesecima ne oduzima nabavu robe s ulaznih računa dvaput; troškovi/neto rezultat bez prava „costs"
 *  #10 trošak primke povezanog računa za robu plaća se preko računa
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { Actor } from '../../src/server/services/items';
import { receiveGoods, saveOrder, setOrderStatus } from '../../src/server/services/purchasing';
import { rebookSupplierInvoice, saveSupplierInvoice, setSupplierInvoicesPaid } from '../../src/server/services/supplier-invoices';
import { acceptSupplierInvoice } from '../../src/server/services/inbound';
import { fetchIncoming } from '../../src/server/services/inbound-fetch';
import { setExpensesPaid } from '../../src/server/services/expenses';
import { requestStatusChange, resolveApproval } from '../../src/server/services/warehouse';
import { expensesByMonth } from '../../src/server/queries/reports/costs';
import { findReport, readFilters, runReport } from '../../src/server/queries/reports';
import { dashboardData } from '../../src/server/queries/dashboard';
import { resolvePermissions } from '../../src/domain/permissions';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');
process.env.AUTH_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';

const companies: string[] = [];

async function setup(tag: string, extra: Record<string, unknown> = {}) {
  const c = await db.company.create({ data: { name: `B-qa ${tag} ${Date.now()}-${Math.random()}`, ...extra } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `bq${tag}${Date.now()}${Math.random()}@t.hr`, name: 'Nabava B', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: `V2-${tag}` } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const supplier = await db.partner.create({ data: { companyId: c.id, name: 'Distributer d.o.o.', country: 'HR', isSupplier: true, oib: '12345678903' } });
  return { companyId: c.id, actor, model, wh, supplier };
}
type S = Awaited<ReturnType<typeof setup>>;

async function orderOf(s: S, qty: number, unitCost = 100) {
  const o = await transaction((tx) => saveOrder(tx, s.actor, null, { supplierId: s.supplier.id, date: '2026-05-01', lines: [{ modelId: s.model.id, qty, unitCost }] }));
  await transaction((tx) => setOrderStatus(tx, s.actor, o.id, 'ORDERED'));
  const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { orderId: o.id } });
  return { id: o.id, lineId: line.id };
}

const receive = (s: S, o: { id: string; lineId: string } | null, serials: string[], unitCost = 100, supplierId = s.supplier.id) =>
  transaction((tx) =>
    receiveGoods(tx, s.actor, {
      orderId: o?.id ?? null,
      supplierId: o ? null : supplierId,
      warehouseId: s.wh.id,
      date: '2026-05-10',
      lines: [{ modelId: s.model.id, unitCost, serials, orderLineId: o?.lineId ?? null }],
    }),
  );

const invoice = (s: S, id: string | null, over: Partial<Parameters<typeof saveSupplierInvoice>[3]> = {}) =>
  transaction((tx) =>
    saveSupplierInvoice(tx, s.actor, id, { supplierId: s.supplier.id, number: `R-${Math.random().toString(36).slice(2, 8)}`, issueDate: '2026-05-12', netAmount: 200, vatAmount: 50, book: true, ...over }),
  );

async function goodsExpense(s: S) {
  const a = await db.expense.aggregate({ where: { companyId: s.companyId, source: { in: ['RECEIPT', 'SUPPLIER_INVOICE'] } }, _sum: { netAmount: true }, _count: { _all: true } });
  return { net: Number(a._sum.netAmount ?? 0), count: a._count._all };
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

test('#1 roba pa prijevoz (bez izričite odluke) pa račun za robu: prijevoz se knjiži, roba jednom', async () => {
  const s = await setup('freight');
  const o = await orderOf(s, 2);
  await receive(s, o, ['E-1', 'E-2']);
  // obrazac više ne šalje zastarjelu kvačicu: goods = null → poslužitelj odlučuje po STVARNOJ osnovici (25 ≠ 200)
  const freight = await invoice(s, null, { orderId: o.id, netAmount: 25, vatAmount: 6.25, goods: null });
  assert.equal(freight.mode, 'own', 'prijevoz je zaseban trošak');
  assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: freight.id } })).goodsInvoice, false);
  const goods = await invoice(s, null, { orderId: o.id, netAmount: 200, vatAmount: 50, goods: null });
  assert.equal(goods.mode, 'receipt', 'prijevoz se ne broji kao račun za robu');
  assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: goods.id } })).goodsInvoice, true);
  assert.deepEqual(await goodsExpense(s), { net: 225, count: 2 }, 'primka 200 + prijevoz 25');
  // izmjena bez odluke zadržava spremljenu odluku (i kad se promijeni iznos)
  const fr = await db.supplierInvoice.findUniqueOrThrow({ where: { id: freight.id } });
  await invoice(s, freight.id, { number: fr.number, orderId: o.id, netAmount: 200, vatAmount: 50, goods: null });
  assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: freight.id } })).goodsInvoice, false);
});

test('#1 prijevoz prije robe: primka i dalje knjiži robu (trošak prijevoza nije roba)', async () => {
  const s = await setup('freight-first');
  const o = await orderOf(s, 2);
  const freight = await invoice(s, null, { orderId: o.id, netAmount: 25, vatAmount: 6.25 });
  assert.equal(freight.mode, 'own');
  const r = await receive(s, o, ['F-1', 'F-2']);
  assert.equal(r.booked, true, 'primka knjiži nabavu robe');
  assert.deepEqual(await goodsExpense(s), { net: 225, count: 2 });
});

test('#2 eRačun: „račun za robu" se pamti i poštuje pri prihvaćanju i „Knjiži ponovno"', async () => {
  const s = await setup('einv', { oib: '12345678903', fiscalEnv: 'TEST', eInvoiceProvider: 'demo' });
  await fetchIncoming(s.actor);
  const si = await db.supplierInvoice.findFirstOrThrow({ where: { companyId: s.companyId, eInvoiceId: 'DEMO-IN-1001' } });
  assert.equal(Number(si.netAmount), 740);
  // primka istog dobavljača od 720 (razlika > 1 % — pravilo iznosa bi reklo „nije račun za robu")
  const r = await receive(s, null, ['EI-1'], 720, si.supplierId);
  assert.equal(r.booked, true);
  const saved = await transaction((tx) =>
    saveSupplierInvoice(tx, s.actor, si.id, { supplierId: si.supplierId, number: si.number, issueDate: '2026-05-12', netAmount: 740, vatAmount: 185, receiptId: r.id, book: true, goods: true }),
  );
  assert.equal(saved.mode, 'none', 'zaprimljeni eRačun ne knjiži ništa');
  assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: si.id } })).goodsInvoice, true, 'odluka je spremljena');
  const acc = await acceptSupplierInvoice(s.actor, si.id);
  assert.equal(acc.mode, 'partial', 'račun za robu (740) uz primku (720) knjiži samo razliku');
  const after1 = await db.supplierInvoice.findUniqueOrThrow({ where: { id: si.id }, include: { expense: true } });
  assert.equal(after1.status, 'ACCEPTED');
  assert.equal(Number(after1.expense?.netAmount), 20, 'roba je knjižena primkom (720), račun knjiži samo 20 iznad nje');
  const exp = await db.expense.findMany({ where: { companyId: s.companyId }, orderBy: { netAmount: 'desc' } });
  assert.deepEqual(exp.map((e) => Number(e.netAmount)), [720, 20], 'ukupno max(720, 740) = 740');
  // „Knjiži ponovno" ne knjiži dvaput
  await assert.rejects(transaction((tx) => rebookSupplierInvoice(tx, s.actor, si.id)), /već knjižen/);
  assert.equal(await db.expense.count({ where: { companyId: s.companyId } }), 2);
  // #10 plaćenost: trošak primke se ne plaća ručno — prelazi s računa
  const re = await db.expense.findFirstOrThrow({ where: { receiptId: r.id } });
  await assert.rejects(transaction((tx) => setExpensesPaid(tx, s.actor, [re.id], true)), /preko ulaznog računa/);
  await transaction((tx) => setSupplierInvoicesPaid(tx, s.actor, [si.id], '2026-05-20'));
  assert.equal((await db.expense.findUniqueOrThrow({ where: { id: re.id } })).paid, true);
});

test('#10 trošak primke bez računa za robu plaća se ručno kao i prije', async () => {
  const s = await setup('pay');
  const r = await receive(s, null, ['P-1']);
  const e = await db.expense.findFirstOrThrow({ where: { receiptId: r.id } });
  await transaction((tx) => setExpensesPaid(tx, s.actor, [e.id], true));
  assert.equal((await db.expense.findUniqueOrThrow({ where: { id: e.id } })).paid, true);
});

test('#3 vlastiti zahtjev za promjenu statusa ne može se odobriti (ni administrator); drugi korisnik može', async () => {
  const s = await setup('self');
  await receive(s, null, ['S-1']);
  const item = await db.item.findFirstOrThrow({ where: { companyId: s.companyId, serial: 'S-1' } });
  const target = await db.itemStatus.findFirstOrThrow({ where: { companyId: s.companyId, kind: 'OTHER' } });
  const req = await transaction((tx) => requestStatusChange(tx, s.actor, { itemIds: [item.id], statusId: target.id, note: null }));
  await assert.rejects(transaction((tx) => resolveApproval(tx, s.actor, req.id, true, null)), /Vlastiti zahtjev/);
  const other = await db.user.create({ data: { companyId: s.companyId, email: `o${Date.now()}${Math.random()}@t.hr`, name: 'Voditelj', passwordHash: 'x', role: 'ADMIN' } });
  const r = await transaction((tx) => resolveApproval(tx, { id: other.id, name: other.name, companyId: s.companyId }, req.id, true, null));
  assert.equal(r.applied, 1);
  // vlastiti zahtjev se smije povući (odbiti)
  const req2 = await transaction((tx) => requestStatusChange(tx, s.actor, { itemIds: [item.id], statusId: target.id, note: null }));
  await transaction((tx) => resolveApproval(tx, s.actor, req2.id, false, 'Povlačim'));
});

test('#5 profit po mjesecima: nabava robe s ulaznog računa (račun prije robe) ne ulazi u troškove poslovanja', async () => {
  const s = await setup('profit');
  const o = await orderOf(s, 2);
  // račun za robu stigao prije robe → vlastiti trošak „Nabava robe" 200; primka ga ne knjiži ponovno
  const goods = await invoice(s, null, { orderId: o.id, netAmount: 200, vatAmount: 50, category: 'Nabava robe' });
  assert.equal(goods.mode, 'own');
  await receive(s, o, ['PR-1', 'PR-2']);
  // prijevoz je trošak poslovanja
  await invoice(s, null, { orderId: o.id, netAmount: 30, vatAmount: 7.5, category: 'Nabava robe' });
  const all = await expensesByMonth(s.companyId, 2026);
  const ops = await expensesByMonth(s.companyId, 2026, { excludePurchases: true });
  assert.equal(all.total[4], 230);
  assert.equal(ops.total[4], 30, 'samo prijevoz');

  // bez prava „costs": neto rezultat se ne prikazuje, troškovi po mjesecima su bez nabave robe, nadzorna ploča bez troškova
  const neto = findReport('neto-rezultat')!;
  assert.equal(neto.requiresCost, true);
  const tpm = findReport('troskovi-po-mjesecima')!;
  const f = readFilters(tpm, new URLSearchParams({ godina: '2026' }));
  const withCost = await runReport(tpm, s.companyId, f, { canSeeCost: true });
  const noCost = await runReport(tpm, s.companyId, f, { canSeeCost: false });
  assert.equal(withCost.totals?.total, 230);
  assert.equal(noCost.totals?.total, 30);
  const noCostPerms = resolvePermissions('MANAGER', { costs: 'none' });
  const d1 = await dashboardData(s.companyId, noCostPerms);
  assert.equal(d1.kpi.expenses, null);
  const d2 = await dashboardData(s.companyId, resolvePermissions('ADMIN', null));
  assert.ok(d2.kpi.expenses);
});
