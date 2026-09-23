/**
 * Integracijski testovi servisa nad pravom bazom (zasebna testna baza).
 *   npm run test:db
 * Svaki test radi u vlastitoj firmi, pa su neovisni jedan o drugome.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { changeItemStatus, statusFor, type Actor } from '../../src/server/services/items';
import { createDraft, issueInvoice, stornoInvoice, addPayment, creditNote, markPaid, markUnpaid } from '../../src/server/services/invoices';
import { attachItems, pendingForCompany, issueInstallments, skipInstallment } from '../../src/server/services/rentals';
import { fromISO, today, addMonths } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];

async function setup() {
  const c = await db.company.create({ data: { name: `Test ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `u${Date.now()}${Math.random()}@t.hr`, name: 'Tester', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20 } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const items = [];
  for (let i = 0; i < 6; i++) {
    items.push(
      await db.item.create({
        data: { companyId: c.id, serial: `SN${i}`, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2026-01-01') },
      }),
    );
  }
  return { companyId: c.id, actor, model, wh, partner, items };
}

const saleLine = (itemId: string, price = 200) => ({ kind: 'DEVICE' as const, itemId, description: 'Sunmi T2s', qty: 1, unitPrice: price });

before(async () => {
  await db.$connect();
});

after(async () => {
  for (const id of companies) {
    await db.user.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } });
  }
  await db.$disconnect();
});

test('izdavanje: redni brojevi po godini, datum mora pratiti broj', async () => {
  const s = await setup();
  const mk = (date: string) =>
    transaction(async (tx) => {
      const d = await createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date, vatRate: 25, lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 10 }] });
      return issueInvoice(tx, s.actor, d.id);
    });
  assert.equal((await mk('2026-02-01')).number, '1/T1/1');
  assert.equal((await mk('2026-02-05')).number, '2/T1/1');
  await assert.rejects(mk('2026-02-03'), /redni broj mora pratiti datum/);
  // neuspjeli pokušaj ne troši broj (transakcija se poništila)
  assert.equal((await mk('2026-02-05')).number, '3/T1/1');
  assert.equal((await mk('2027-01-02')).number, '1/T1/1');
});

test('istovremeno izdavanje nikad ne daje isti broj', async () => {
  const s = await setup();
  const drafts = await Promise.all(
    Array.from({ length: 8 }, () =>
      transaction((tx) => createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: '2026-03-01', vatRate: 25, lines: [{ kind: 'MANUAL', description: 'X', qty: 1, unitPrice: 1 }] })),
    ),
  );
  const numbers = await Promise.all(drafts.map((d) => transaction((tx) => issueInvoice(tx, s.actor, d.id))));
  assert.equal(new Set(numbers.map((n) => n.number)).size, 8);
});

test('prodaja skida uređaj sa stanja, storno ga vraća', async () => {
  const s = await setup();
  const inv = await transaction(async (tx) => {
    const d = await createDraft(tx, s.actor, { type: 'SALE', partnerId: s.partner.id, date: today(), vatRate: 25, discountPct: 10, lines: [saleLine(s.items[0].id), saleLine(s.items[1].id, 100)] });
    await issueInvoice(tx, s.actor, d.id);
    return tx.invoice.findUniqueOrThrow({ where: { id: d.id } });
  });
  assert.equal(inv.grandTotal.toNumber(), 337.5); // (300 − 10 %) × 1,25
  assert.equal(inv.costTotal.toNumber(), 200);
  const sold = await db.item.findUniqueOrThrow({ where: { id: s.items[0].id } });
  assert.equal(sold.state, 'SOLD');
  assert.equal(sold.partnerId, s.partner.id);
  assert.equal(sold.salePrice?.toNumber(), 180); // razmjerni dio popusta

  // isti uređaj se ne može prodati dvaput
  await assert.rejects(
    transaction(async (tx) => {
      const d = await createDraft(tx, s.actor, { type: 'SALE', partnerId: s.partner.id, date: today(), vatRate: 25, lines: [saleLine(s.items[0].id)] });
      await issueInvoice(tx, s.actor, d.id);
    }),
    /nisu raspoloživi/,
  );

  const storno = await transaction((tx) => stornoInvoice(tx, s.actor, inv.id));
  const st = await db.invoice.findUniqueOrThrow({ where: { id: storno.id } });
  assert.equal(st.grandTotal.toNumber(), -337.5);
  const orig = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.equal(orig.stornoed, true);
  assert.equal(orig.openAmount.toNumber(), 0);
  const back = await db.item.findUniqueOrThrow({ where: { id: s.items[0].id } });
  assert.equal(back.state, 'IN_STOCK');
  assert.equal(back.partnerId, null);
  assert.equal(back.invoiceId, null);
});

test('uplate, odobrenje i otvoreni iznos', async () => {
  const s = await setup();
  const id = await transaction(async (tx) => {
    const d = await createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: '2026-04-01', vatRate: 25, lines: [{ kind: 'MANUAL', description: 'Servis', qty: 2, unitPrice: 100 }] });
    await issueInvoice(tx, s.actor, d.id);
    return d.id;
  });
  await transaction((tx) => addPayment(tx, s.actor, id, { date: '2026-04-10', amount: 50 }));
  let inv = await db.invoice.findUniqueOrThrow({ where: { id } });
  assert.equal(inv.openAmount.toNumber(), 200);
  await assert.rejects(transaction((tx) => addPayment(tx, s.actor, id, { date: '2026-04-10', amount: 500 })), /veća od otvorenog/);
  await transaction((tx) => creditNote(tx, s.actor, id, { description: 'Popust naknadno', netAmount: 40, date: '2026-04-12' }));
  inv = await db.invoice.findUniqueOrThrow({ where: { id } });
  assert.equal(inv.creditedTotal.toNumber(), 50);
  assert.equal(inv.openAmount.toNumber(), 150);
  await transaction((tx) => markPaid(tx, s.actor, id, '2026-04-20'));
  inv = await db.invoice.findUniqueOrThrow({ where: { id } });
  assert.equal(inv.openAmount.toNumber(), 0);
  assert.equal(inv.paidDate?.toISOString().slice(0, 10), '2026-04-20');
  await assert.rejects(transaction((tx) => stornoInvoice(tx, s.actor, id)), /ima uplate/);
});

test('najam: rate za izdati, izdavanje i pokrivenost po uređaju', async () => {
  const s = await setup();
  const start = addMonths(today(), -3).slice(0, 7) + '-01';
  const contract = await db.contract.create({
    data: { companyId: s.companyId, number: 'UG-T-1', partnerId: s.partner.id, startDate: fromISO(start), billing: 'MONTHLY' },
  });
  await transaction((tx) => attachItems(tx, s.actor, contract.id, [{ itemId: s.items[0].id, monthly: 20 }, { itemId: s.items[1].id, monthly: 30 }], { issueDate: start }));
  const rented = await db.item.findUniqueOrThrow({ where: { id: s.items[0].id } });
  assert.equal(rented.state, 'RENTED');

  const pending = await transaction((tx) => pendingForCompany(tx, s.companyId));
  assert.equal(pending.length, 4); // tri prošla mjeseca + tekući
  assert.equal(pending[0].amount, 50);

  // jedno razdoblje izdano izvan programa za jedan uređaj
  await transaction((tx) => skipInstallment(tx, s.actor, contract.id, pending[0].period, [s.items[0].id]));
  const afterSkip = await transaction((tx) => pendingForCompany(tx, s.companyId));
  assert.equal(afterSkip[0].amount, 30);

  const numbers = await transaction((tx) => issueInstallments(tx, s.actor, afterSkip.map((p) => ({ contractId: p.contractId, period: p.period })), { paid: true }));
  assert.equal(numbers.length, 4);
  assert.equal((await transaction((tx) => pendingForCompany(tx, s.companyId))).length, 0);
  const invs = await db.invoice.findMany({ where: { contractId: contract.id }, orderBy: { seq: 'asc' } });
  assert.ok(invs.every((i) => i.openAmount.toNumber() === 0 && i.type === 'RENT'));

  // storno rate ponovno otvara razdoblje
  await transaction(async (tx) => {
    await markUnpaid(tx, s.actor, invs[1].id);
    await stornoInvoice(tx, s.actor, invs[1].id);
  });
  const reopened = await transaction((tx) => pendingForCompany(tx, s.companyId));
  assert.deepEqual(reopened.map((p) => p.period), [invs[1].period]);
});

test('status uređaja: skladište je čisto, izlaz iz najma skida s ugovora, kvar otvara nalog', async () => {
  const s = await setup();
  const contract = await db.contract.create({ data: { companyId: s.companyId, number: 'UG-T-2', partnerId: s.partner.id, startDate: fromISO(today()) } });
  await transaction((tx) => attachItems(tx, s.actor, contract.id, [{ itemId: s.items[2].id, monthly: 10 }]));

  // povrat s terena: ostaje na ugovoru dok se ne zaprimi
  await transaction((tx) => changeItemStatus(tx, s.actor, [s.items[2].id], { kind: 'RETURNING', event: { type: 'T', message: 't' } }));
  assert.ok(await db.contractItem.findUnique({ where: { itemId: s.items[2].id } }));

  await transaction((tx) => changeItemStatus(tx, s.actor, [s.items[2].id], { kind: 'IN_STOCK', data: { warehouseId: s.wh.id }, event: { type: 'T', message: 't' } }));
  const it = await db.item.findUniqueOrThrow({ where: { id: s.items[2].id }, include: { contractItem: true } });
  assert.equal(it.contractItem, null);
  assert.equal(it.partnerId, null);
  assert.equal(it.state, 'IN_STOCK');

  await transaction((tx) => changeItemStatus(tx, s.actor, [s.items[3].id], { kind: 'SERVICE', event: { type: 'T', message: 't' } }));
  await transaction((tx) => changeItemStatus(tx, s.actor, [s.items[3].id], { kind: 'SERVICE', event: { type: 'T', message: 't' } }));
  assert.equal(await db.serviceOrder.count({ where: { itemId: s.items[3].id } }), 1);

  const events = await db.itemEvent.count({ where: { itemId: s.items[2].id } });
  assert.ok(events >= 3);
});

test('uređaj druge firme ne može se promijeniti', async () => {
  const a = await setup();
  const b = await setup();
  await assert.rejects(
    transaction((tx) => changeItemStatus(tx, a.actor, [b.items[0].id], { kind: 'SOLD', event: { type: 'T', message: 't' } })),
    /ne postoje/,
  );
});

test('kvar uređaja u najmu pamti ugovor u servisnom nalogu', async () => {
  const s = await setup();
  const contract = await db.contract.create({ data: { companyId: s.companyId, number: 'UG-T-3', partnerId: s.partner.id, startDate: fromISO(today()) } });
  await transaction((tx) => attachItems(tx, s.actor, contract.id, [{ itemId: s.items[4].id, monthly: 25, plan: [{ from: today(), billing: 'QUARTERLY' }] }]));
  await transaction((tx) => changeItemStatus(tx, s.actor, [s.items[4].id], { kind: 'SERVICE', event: { type: 'T', message: 't' } }));
  assert.equal(await db.contractItem.count({ where: { itemId: s.items[4].id } }), 0);
  const order = await db.serviceOrder.findFirstOrThrow({ where: { itemId: s.items[4].id } });
  const prev = (order.timeline as Array<{ prev?: { state: string; contract: { contractId: string; monthly: number; plan: unknown } | null } }>)[0].prev;
  assert.equal(prev?.state, 'RENTED');
  assert.equal(prev?.contract?.contractId, contract.id);
  assert.equal(prev?.contract?.monthly, 25);
});
