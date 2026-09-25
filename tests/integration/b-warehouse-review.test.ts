/**
 * Ispravci revizije skladišta i nabave (nad testnom bazom): ručna veza uređaja s
 * računom, sortiranje po nabavnoj bez prava, račun s narudžbenice (bez tuđih
 * računa i prisilnog knjiženja), „račun za robu s primke" samo za račun robe,
 * plaćenost u oba smjera, veza sa storniranom primkom.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { updateItem } from '../../src/server/services/warehouse';
import { cancelReceipt, receiveGoods, saveOrder, setOrderStatus } from '../../src/server/services/purchasing';
import { applyInvoiceExpense, saveOrderInvoice, saveSupplierInvoice, setSupplierInvoicesPaid } from '../../src/server/services/supplier-invoices';
import { parseItemFilters } from '../../src/server/queries/warehouse';
import { fromISO } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup(tag: string) {
  const c = await db.company.create({ data: { name: `B-rev ${tag} ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `brev${tag}${Date.now()}${Math.random()}@t.hr`, name: 'Revizija B', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: `V2-${tag}` } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const supplier = await db.partner.create({ data: { companyId: c.id, name: 'Dobavljač d.o.o.', country: 'HR', isSupplier: true } });
  const customer = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.' } });
  return { companyId: c.id, actor, model, wh, supplier, customer };
}
type S = Awaited<ReturnType<typeof setup>>;

async function orderOf(s: S, qty: number) {
  const o = await transaction((tx) => saveOrder(tx, s.actor, null, { supplierId: s.supplier.id, date: '2026-05-01', lines: [{ modelId: s.model.id, qty, unitCost: 100 }] }));
  await transaction((tx) => setOrderStatus(tx, s.actor, o.id, 'ORDERED'));
  const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { orderId: o.id } });
  return { id: o.id, lineId: line.id };
}

const receive = (s: S, o: { id: string; lineId: string } | null, serials: string[]) =>
  transaction((tx) =>
    receiveGoods(tx, s.actor, {
      orderId: o?.id ?? null,
      supplierId: o ? null : s.supplier.id,
      warehouseId: s.wh.id,
      date: '2026-05-10',
      lines: [{ modelId: s.model.id, unitCost: 100, serials, orderLineId: o?.lineId ?? null }],
    }),
  );

const invoice = (s: S, id: string | null, over: Partial<Parameters<typeof saveSupplierInvoice>[3]> = {}) =>
  transaction((tx) =>
    saveSupplierInvoice(tx, s.actor, id, { supplierId: s.supplier.id, number: `R-${Math.random().toString(36).slice(2, 8)}`, issueDate: '2026-05-12', netAmount: 200, vatAmount: 50, book: true, ...over }),
  );

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

test('kartica uređaja: račun samo uz prodan uređaj koji je stavka izdanog računa; datum izlaza i jamstvo', async () => {
  const s = await setup('card');
  const stock = await transaction((tx) => statusFor(tx, s.companyId, 'IN_STOCK'));
  const soldSt = await transaction((tx) => statusFor(tx, s.companyId, 'SOLD'));
  const mk = (serial: string, over: Record<string, unknown> = {}) =>
    db.item.create({ data: { companyId: s.companyId, serial, modelId: s.model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: s.wh.id, cost: 100, ...over } });
  const inv = (status: 'DRAFT' | 'ISSUED', itemId?: string) =>
    db.invoice.create({
      data: {
        companyId: s.companyId, partnerId: s.customer.id, type: 'SALE', status, number: status === 'ISSUED' ? `T-${Math.random()}` : null, date: fromISO('2026-03-01'), year: 2026, vatRate: 25,
        ...(itemId ? { lines: { create: [{ kind: 'DEVICE', itemId, description: 'uređaj' }] } } : {}),
      },
    });
  const base = { dupNote: null, modelId: s.model.id, supplierId: null, rentPrice: null, warrantyMonths: null, importDate: null, note: null };

  // uređaj na skladištu: ni račun, ni prodajna, ni datum izlaza
  const inStock = await mk('S-1');
  const other = await inv('ISSUED', inStock.id);
  const st = { ...base, serial: 'S-1', warehouseId: s.wh.id };
  await assert.rejects(transaction((tx) => updateItem(tx, s.actor, inStock.id, { ...st, invoiceId: other.id })), /skladištu nije prodan/);
  await assert.rejects(transaction((tx) => updateItem(tx, s.actor, inStock.id, { ...st, salePrice: 10 })), /nema prodajnu cijenu/);
  await assert.rejects(transaction((tx) => updateItem(tx, s.actor, inStock.id, { ...st, issueDate: '2026-03-01' })), /nema datum izlaza/);
  // prazna polja obrasca na skladišnom uređaju nisu izmjena
  await transaction((tx) => updateItem(tx, s.actor, inStock.id, { ...st, salePrice: null, issueDate: null, invoiceId: null }));

  // prodan uređaj: račun mora biti izdan i imati ga kao stavku
  const sold = await mk('S-2', { statusId: soldSt.id, state: 'SOLD', warehouseId: null, issueDate: fromISO('2026-02-01'), warrantyStart: fromISO('2026-02-01') });
  const sb = { ...base, serial: 'S-2', warehouseId: null };
  const draft = await inv('DRAFT', sold.id);
  await assert.rejects(transaction((tx) => updateItem(tx, s.actor, sold.id, { ...sb, invoiceId: draft.id })), /izdan račun/);
  await assert.rejects(transaction((tx) => updateItem(tx, s.actor, sold.id, { ...sb, invoiceId: other.id })), /nije stavka odabranog računa/);
  const own = await inv('ISSUED', sold.id);
  await transaction((tx) => updateItem(tx, s.actor, sold.id, { ...sb, invoiceId: own.id, issueDate: '2026-03-01' }));
  const after1 = await db.item.findUniqueOrThrow({ where: { id: sold.id } });
  assert.equal(after1.invoiceId, own.id);
  assert.equal(after1.warrantyStart?.toISOString().slice(0, 10), '2026-03-01', 'početak jamstva prati datum izlaza');
  // prodan uređaj ne gubi datum izlaza; veza s izdanim računom se ne mijenja ručno (storno vraća po njoj)
  await assert.rejects(transaction((tx) => updateItem(tx, s.actor, sold.id, { ...sb, issueDate: null })), /mora imati datum izlaza/);
  await assert.rejects(transaction((tx) => updateItem(tx, s.actor, sold.id, { ...sb, invoiceId: null })), /stavka izdanog računa/);
});

test('popis uređaja: sortiranje po nabavnoj samo s pravom na nabavne cijene', () => {
  assert.equal(parseItemFilters({ sort: 'nabavna', dir: 'desc' }, { canSeeCost: false }).sort, null);
  assert.deepEqual(parseItemFilters({ sort: 'nabavna', dir: 'desc' }, { canSeeCost: true }).sort, { sort: 'nabavna', dir: 'desc' });
  assert.deepEqual(parseItemFilters({ sort: 'uvoz', dir: 'asc' }, { canSeeCost: false }).sort, { sort: 'uvoz', dir: 'asc' });
});

test('račun s narudžbenice: ne dira račun prijevoza ni račun druge narudžbenice; poštuje „ne knjiži"; eRačun na čekanju se ne knjiži', async () => {
  const s = await setup('sync');
  const o = await orderOf(s, 2);
  await receive(s, o, ['SY-1', 'SY-2']);
  // račun prijevoza na istoj narudžbenici (iznos ne odgovara robi → vlastiti trošak)
  const freight = await invoice(s, null, { orderId: o.id, number: 'PRIJEVOZ-1', netAmount: 30, vatAmount: 7.5 });
  assert.equal(freight.mode, 'own');
  // račun robe upisan na narudžbenici nastaje kao zaseban ulazni račun, prijevoz se ne prepisuje
  await transaction((tx) =>
    saveOrderInvoice(tx, s.actor, o.id, {
      supplierInvoiceNo: 'ROBA-1', supplierInvoiceDate: '2026-05-09', supplierInvoiceDueDate: null, supplierInvoiceCurrency: null,
      supplierInvoiceNet: 200, supplierInvoiceVat: 50, supplierInvoiceTotal: null,
    }),
  );
  const f = await db.supplierInvoice.findUniqueOrThrow({ where: { id: freight.id }, include: { expense: true } });
  assert.equal(f.number, 'PRIJEVOZ-1', 'račun prijevoza nije prepisan');
  assert.equal(Number(f.expense?.netAmount), 30, 'prijevoz zadržava vlastiti trošak');
  const goods = await db.supplierInvoice.findFirstOrThrow({ where: { companyId: s.companyId, number: 'ROBA-1' }, include: { expense: true } });
  assert.equal(goods.orderId, o.id);
  assert.equal(goods.expense, null, 'roba je knjižena primkom');

  // isti broj već povezan s drugom narudžbenicom — ne preuzima se
  const o2 = await orderOf(s, 1);
  await receive(s, o2, ['SY-3']);
  await assert.rejects(
    transaction((tx) =>
      saveOrderInvoice(tx, s.actor, o2.id, {
        supplierInvoiceNo: 'ROBA-1', supplierInvoiceDate: null, supplierInvoiceDueDate: null, supplierInvoiceCurrency: null,
        supplierInvoiceNet: null, supplierInvoiceVat: null, supplierInvoiceTotal: null,
      }),
    ),
    /povezan s narudžbenicom/,
  );
  assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: goods.id } })).orderId, o.id);

  // postojeći račun bez knjiženja (primka bez troška) ostaje bez troška
  const s2 = await setup('sync2');
  const o3 = await orderOf(s2, 1);
  const r3 = await transaction((tx) =>
    receiveGoods(tx, s2.actor, { orderId: o3.id, warehouseId: s2.wh.id, date: '2026-05-10', bookExpense: false, lines: [{ modelId: s2.model.id, unitCost: 100, serials: ['NB-1'], orderLineId: o3.lineId }] }),
  );
  assert.equal(r3.booked, false);
  const nb = await invoice(s2, null, { number: 'NB-R', netAmount: 100, vatAmount: 25, book: false });
  await transaction((tx) =>
    saveOrderInvoice(tx, s2.actor, o3.id, {
      supplierInvoiceNo: 'NB-R', supplierInvoiceDate: null, supplierInvoiceDueDate: null, supplierInvoiceCurrency: null,
      supplierInvoiceNet: 100, supplierInvoiceVat: 25, supplierInvoiceTotal: null,
    }),
  );
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: nb.id } }), 0, 'izbor „ne knjiži" se poštuje');

  // zaprimljeni eRačun se ne knjiži ni kad se poveže s narudžbenicom
  const o4 = await orderOf(s2, 1);
  await transaction((tx) =>
    receiveGoods(tx, s2.actor, { orderId: o4.id, warehouseId: s2.wh.id, date: '2026-05-10', bookExpense: false, lines: [{ modelId: s2.model.id, unitCost: 100, serials: ['EI-1'], orderLineId: o4.lineId }] }),
  );
  const e = await db.supplierInvoice.create({
    data: { companyId: s2.companyId, internalNo: `URA-E-${Math.random()}`, number: 'EI-9', supplierId: s2.supplier.id, issueDate: fromISO('2026-05-10'), netAmount: 100, vatAmount: 25, total: 125, source: 'EINVOICE', status: 'RECEIVED', eInvoiceId: `ext-${Math.random()}` },
  });
  await transaction((tx) =>
    saveOrderInvoice(tx, s2.actor, o4.id, {
      supplierInvoiceNo: 'EI-9', supplierInvoiceDate: null, supplierInvoiceDueDate: null, supplierInvoiceCurrency: null,
      supplierInvoiceNet: null, supplierInvoiceVat: null, supplierInvoiceTotal: null,
    }),
  );
  assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: e.id } })).orderId, o4.id);
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: e.id } }), 0);
  assert.equal(await transaction((tx) => applyInvoiceExpense(tx, s2.actor, e.id, true)), 'none');
});

test('račun za robu s primke: samo račun robe; drugi račun (prijevoz) knjiži svoj trošak; izričit izbor ima prednost', async () => {
  const s = await setup('goods');
  const r = await receive(s, null, ['G-1', 'G-2']);
  // iznos odgovara primci (±1 %) i prvi je račun → račun za robu
  const g = await invoice(s, null, { receiptId: r.id, netAmount: 201.5, vatAmount: 50 });
  // trošak robe = max(primka 200, račun 201,50) — račun knjiži samo razliku 1,50
  assert.equal(g.mode, 'partial');
  assert.equal(Number((await db.expense.findFirstOrThrow({ where: { supplierInvoiceId: g.id } })).netAmount), 1.5);
  // drugi račun iste primke — ni s jednakim iznosom nije zadano račun za robu
  const second = await invoice(s, null, { receiptId: r.id, netAmount: 200, vatAmount: 50 });
  assert.equal(second.mode, 'own');
  // prijevoz: iznos ne odgovara → vlastiti trošak
  const freight = await invoice(s, null, { receiptId: r.id, netAmount: 25, vatAmount: 6.25 });
  assert.equal(freight.mode, 'own');
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: freight.id } }), 1);
  // izričito „nije račun za robu" / „je račun za robu"
  const s2 = await setup('goods2');
  const r2 = await receive(s2, null, ['G-3']);
  assert.equal((await invoice(s2, null, { receiptId: r2.id, netAmount: 100, vatAmount: 25, goods: false })).mode, 'own');
  const s3 = await setup('goods3');
  const r3 = await receive(s3, null, ['G-4']);
  assert.equal((await invoice(s3, null, { receiptId: r3.id, netAmount: 90, vatAmount: 22.5, goods: true })).mode, 'receipt', 'popust na računu — korisnik potvrđuje');
  assert.equal(await db.expense.count({ where: { companyId: s3.companyId } }), 1, 'roba jednom');
});

test('plaćenost računa za robu: poništavanje vraća primku; kasnija primka nosi plaćenost', async () => {
  const s = await setup('paid');
  const o = await orderOf(s, 2);
  const r1 = await receive(s, o, ['P-1']);
  const si = await invoice(s, null, { orderId: o.id, netAmount: 200, vatAmount: 50 });
  assert.equal(si.mode, 'partial', 'primka 100 od 200 — račun knjiži razliku 100');
  await transaction((tx) => setSupplierInvoicesPaid(tx, s.actor, [si.id], '2026-05-20'));
  let e1 = await db.expense.findFirstOrThrow({ where: { receiptId: r1.id } });
  assert.equal(e1.paid, true);
  // druga primka po plaćenoj narudžbenici → trošak odmah plaćen
  const r2 = await receive(s, o, ['P-2']);
  const e2 = await db.expense.findFirstOrThrow({ where: { receiptId: r2.id } });
  assert.equal(e2.paid, true);
  assert.equal(e2.paidDate?.toISOString().slice(0, 10), '2026-05-20');
  // poništavanje plaćanja vraća i troškove primki
  await transaction((tx) => setSupplierInvoicesPaid(tx, s.actor, [si.id], null));
  e1 = await db.expense.findFirstOrThrow({ where: { receiptId: r1.id } });
  assert.equal(e1.paid, false);
  assert.equal(await db.expense.count({ where: { companyId: s.companyId, receiptId: { not: null }, paid: true } }), 0);
  // i kroz obrazac: plaćeno pa prazno
  await invoice(s, si.id, { number: (await db.supplierInvoice.findUniqueOrThrow({ where: { id: si.id } })).number, orderId: o.id, paidDate: '2026-05-21' });
  assert.equal(await db.expense.count({ where: { companyId: s.companyId, receiptId: { not: null }, paid: true } }), 2);
  await invoice(s, si.id, { number: (await db.supplierInvoice.findUniqueOrThrow({ where: { id: si.id } })).number, orderId: o.id, paidDate: null });
  assert.equal(await db.expense.count({ where: { companyId: s.companyId, receiptId: { not: null }, paid: true } }), 0);
});

test('storno primke: račun povezan s njom se i dalje sprema (veza ostaje kao trag), nova veza se odbija', async () => {
  const s = await setup('storno');
  const r = await receive(s, null, ['X-1']);
  const si = await invoice(s, null, { number: 'X-R', receiptId: r.id, netAmount: 100, vatAmount: 25 });
  await transaction((tx) => cancelReceipt(tx, s.actor, r.id));
  const saved = await invoice(s, si.id, { number: 'X-R', receiptId: r.id, netAmount: 100, vatAmount: 25, note: 'izmjena' });
  assert.equal(saved.mode, 'own', 'stornirana primka nema trošak — račun knjiži svoj');
  await assert.rejects(invoice(s, null, { receiptId: r.id }), /stornirana/);
});
