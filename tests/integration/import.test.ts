/**
 * Uvoz iz stare verzije i sigurnosna kopija — nad testnom bazom (wms_test).
 *   npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db, transaction } from '../../src/server/db';
import { mapLegacy } from '../../src/server/import/legacy';
import { runImport, type ImportActor } from '../../src/server/import/run';
import { backupToPlan, exportCompanyStream } from '../../src/server/import/backup';
import { planCounts } from '../../src/server/import/plan';
import { recalcInvoice, createDraft, issueInvoice } from '../../src/server/services/invoices';
import { pendingForCompany } from '../../src/server/services/rentals';
import { nextDocNumber } from '../../src/server/numbering';
import { num } from '../../src/domain/money';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'fixtures', 'legacy-sample.json'), 'utf8'));
const quiet = () => {};

/** Firma i korisnik koji pokreće uvoz. */
async function actorCompany(): Promise<ImportActor> {
  const c = await db.company.create({ data: { name: `Uvoznik ${Date.now()}-${Math.random()}` } });
  companies.push(c.id);
  const u = await db.user.create({ data: { companyId: c.id, email: `uvoz${Date.now()}${Math.random()}@t.hr`, name: 'Uvoznik', passwordHash: 'x', role: 'ADMIN' } });
  return { id: u.id, name: u.name, email: u.email, companyId: c.id };
}

async function importNew(raw: unknown, actor: ImportActor, today = '2026-09-23') {
  const { plan } = mapLegacy(raw, { today })!;
  const r = await runImport(plan, { target: { kind: 'new', name: `Uvoz ${Date.now()}-${Math.random()}` }, actor, log: quiet });
  companies.push(r.companyId);
  return { plan, r };
}

/** Brisanje firme redom (neke veze nemaju kaskadu). */
async function deleteCompany(companyId: string) {
  const w = { where: { companyId } };
  await db.$transaction([
    db.session.deleteMany({ where: { user: { companyId } } }),
    db.user.deleteMany(w),
    db.payment.deleteMany({ where: { invoice: { companyId } } }),
    db.quote.deleteMany(w),
    db.serviceOrder.deleteMany(w),
    db.expense.deleteMany(w),
    db.invoice.updateMany({ ...w, data: { refInvoiceId: null } }),
    db.item.updateMany({ ...w, data: { invoiceId: null, receiptId: null } }),
    db.invoice.deleteMany(w),
    db.contract.deleteMany(w),
    db.transfer.deleteMany(w),
    db.supplierInvoice.deleteMany(w),
    db.goodsReceipt.deleteMany(w),
    db.purchaseOrder.deleteMany(w),
    db.item.deleteMany(w),
    db.company.delete({ where: { id: companyId } }),
  ]);
}

before(async () => {
  await db.$connect();
});

after(async () => {
  for (const id of companies.reverse()) await deleteCompany(id).catch(() => {});
  await db.$disconnect();
});

test('uvoz ogledne datoteke u novu firmu: broj zapisa, zbrojevi, brojači, administrator', async () => {
  const actor = await actorCompany();
  const { plan, r } = await importNew(fixture, actor);
  const n = planCounts(plan);
  const cid = r.companyId;
  assert.equal(await db.item.count({ where: { companyId: cid } }), n.items);
  assert.equal(await db.invoice.count({ where: { companyId: cid } }), n.invoices);
  assert.equal(await db.invoiceLine.count({ where: { invoice: { companyId: cid } } }), n.invoiceLines);
  assert.equal(await db.payment.count({ where: { invoice: { companyId: cid } } }), n.payments);
  assert.equal(await db.contractItem.count({ where: { contract: { companyId: cid } } }), n.contractItems);
  assert.equal(await db.partner.count({ where: { companyId: cid } }), n.partners);
  assert.equal(await db.itemEvent.count({ where: { companyId: cid, type: 'IMPORT' } }), n.items);
  assert.equal(await db.auditLog.count({ where: { companyId: cid, entity: 'import' } }), 1);
  assert.equal(await db.auditLog.count({ where: { companyId: actor.companyId, entity: 'import', entityId: cid } }), 1);

  // spremljeni zbrojevi jednaki su preračunu servisa
  const before = await db.invoice.findMany({ where: { companyId: cid }, orderBy: { id: 'asc' } });
  await transaction(async (tx) => {
    for (const i of before) await recalcInvoice(tx, i.id);
  });
  const after = await db.invoice.findMany({ where: { companyId: cid }, orderBy: { id: 'asc' } });
  for (const [k, a] of before.entries()) {
    const b = after[k];
    for (const f of ['netTotal', 'vatTotal', 'chargesTotal', 'grandTotal', 'paidTotal', 'creditedTotal', 'openAmount', 'costTotal'] as const) {
      assert.equal(num(a[f]), num(b[f]), `${a.number} ${f}`);
    }
    assert.equal(a.paidDate?.toISOString() ?? null, b.paidDate?.toISOString() ?? null, `${a.number} paidDate`);
  }
  const lines = await db.invoiceLine.findMany({ where: { invoice: { companyId: cid } }, select: { netAmount: true, qty: true, unitPrice: true, discountPct: true } });
  for (const l of lines) assert.equal(num(l.netAmount), Math.round(num(l.qty) * num(l.unitPrice) * (1 - num(l.discountPct) / 100) * 100) / 100);

  // brojač računa = najveći uvezeni redni broj → novi račun nastavlja numeraciju
  const maxSeq = Math.max(...plan.invoices.filter((i) => i.year === 2026 && i.seq).map((i) => i.seq!));
  const counter = await db.documentCounter.findUnique({ where: { companyId_series_year: { companyId: cid, series: 'INVOICE', year: 2026 } } });
  assert.equal(counter?.last, maxSeq);
  const admin = await db.user.findUniqueOrThrow({ where: { email: r.admin!.email } });
  assert.equal(admin.companyId, cid);
  assert.equal(admin.role, 'ADMIN');
  const adminActor = { id: admin.id, name: admin.name, companyId: cid };
  const partner = await db.partner.findFirstOrThrow({ where: { companyId: cid, isCustomer: true } });
  const issued = await transaction(async (tx) => {
    const last = await tx.invoice.findFirstOrThrow({ where: { companyId: cid, status: 'ISSUED', year: 2026 }, orderBy: { date: 'desc' } });
    const d = await createDraft(tx, adminActor, { type: 'SERVICE', partnerId: partner.id, date: last.date.toISOString().slice(0, 10), vatRate: 25, lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 10 }] });
    return issueInvoice(tx, adminActor, d.id);
  });
  assert.ok(issued.number.startsWith(`${maxSeq + 1}/`), issued.number);
  // ostale serije: novi ugovor ne sudara se s uvezenim brojevima
  const ug = await transaction((tx) => nextDocNumber(tx, cid, 'SERVICE', 2026));
  assert.notEqual(await db.serviceOrder.count({ where: { companyId: cid, number: ug } }), 1);

  // pravila stanja uređaja
  assert.equal(await db.item.count({ where: { companyId: cid, state: 'IN_STOCK', OR: [{ partnerId: { not: null } }, { invoiceId: { not: null } }] } }), 0);
  assert.equal(await db.item.count({ where: { companyId: cid, state: { not: 'RESERVED' }, outAt: { not: null } } }), 0);
  assert.equal(await db.contractItem.count({ where: { contract: { companyId: cid }, item: { state: { notIn: ['RENTED', 'RETURNING'] } } } }), 0);
  const statuses = await db.itemStatus.findMany({ where: { companyId: cid } });
  const kinds = new Map(statuses.map((s) => [s.id, s.kind]));
  for (const it of await db.item.findMany({ where: { companyId: cid }, select: { statusId: true, state: true } })) assert.equal(kinds.get(it.statusId), it.state);
});

test('najam: rate za izdati poštuju uvezene račune i preskočena razdoblja', async () => {
  const actor = await actorCompany();
  const base = {
    users: [], warehouses: [{ id: 'w1', name: 'Glavno' }], models: [{ id: 'm1', brand: 'Sunmi', name: 'T2' }],
    statuses: [{ id: 's1', name: 'Na skladištu', inStock: true }, { id: 's3', name: 'U najmu', rented: true }],
    partners: [{ id: 'p1', name: 'Najmoprimac d.o.o.', country: 'HR' }],
    items: [
      { id: 'a', serial: 'A1', statusId: 's3', partnerId: 'p1', modelId: 'm1', cost: 400 },
      { id: 'b', serial: 'B1', statusId: 's3', partnerId: 'p1', modelId: 'm1', cost: 400 },
    ],
    contracts: [{ id: 'k1', number: 'UG-2026-001', partnerId: 'p1', itemIds: ['a', 'b'], prices: { a: 20, b: '15,50' }, startDate: '2026-01-01', billing: 'mjesecno', billingMode: 'unaprijed', status: 'aktivan', skipped: ['b|2026-01'] }],
    invoices: [
      { id: 'r1', number: '1/ZG/1', partnerId: 'p1', type: 'najam', contractId: 'k1', period: '2026-01', date: '2026-01-02', vatRate: 25, lines: [{ itemId: 'a', desc: 'Najam', qty: 1, monthly: 20, price: 20, kind: 'uredaj' }], paidDate: '2026-01-10' },
      // storniran račun ne pokriva ratu
      { id: 'r2', number: '2/ZG/1', partnerId: 'p1', type: 'najam', contractId: 'k1', period: '2026-02', date: '2026-02-02', vatRate: 25, lines: [{ itemId: 'a', desc: 'Najam', qty: 1, monthly: 20, price: 20, kind: 'uredaj' }], stornoId: 'r3' },
      { id: 'r3', number: '3/ZG/1', kind: 'storno', refInvoiceId: 'r2', partnerId: 'p1', type: 'najam', date: '2026-02-03', vatRate: 25, lines: [{ desc: 'Najam', qty: 1, price: -20 }] },
    ],
    settings: { companyName: 'Najam test' },
  };
  const { r } = await importNew(base, actor, '2026-03-15');
  const pending = await transaction((tx) => pendingForCompany(tx, r.companyId, { now: '2026-03-15' }));
  const rows = pending.map((p) => [p.period, p.lines.map((l) => l.itemId).length, p.amount]);
  // siječanj: a fakturiran, b preskočen · veljača: storno ne pokriva → oba · ožujak: oba
  assert.deepEqual(rows, [['2026-02', 2, 35.5], ['2026-03', 2, 35.5]]);
  const ci = await db.contractItem.findMany({ where: { contract: { companyId: r.companyId } }, include: { item: true }, orderBy: { monthly: 'asc' } });
  assert.deepEqual(ci.map((c) => [c.item.serial, num(c.monthly), c.skipped]), [['B1', 15.5, ['2026-01']], ['A1', 20, []]]);
  const r2 = await db.invoice.findFirstOrThrow({ where: { companyId: r.companyId, number: '2/ZG/1' } });
  assert.ok(r2.stornoed);
  assert.equal(num(r2.openAmount), 0);
});

test('uvoz u postojeću firmu preskače zapise koji već postoje', async () => {
  const actor = await actorCompany();
  const { plan } = mapLegacy(fixture, { today: '2026-09-23' })!;
  const first = await runImport(plan, { target: { kind: 'current' }, actor, log: quiet });
  assert.equal(first.admin, undefined);
  assert.equal(first.created.items, plan.items.length);
  const again = mapLegacy(fixture, { today: '2026-09-23' })!.plan;
  const second = await runImport(again, { target: { kind: 'current' }, actor, log: quiet });
  assert.equal(second.created.items ?? 0, 0);
  assert.equal(second.skipped.items, plan.items.length);
  assert.equal(second.created.invoices ?? 0, plan.invoices.filter((i) => !i.seq).length); // bez rednog broja nema prirodnog ključa
  assert.equal(second.skipped.contracts, plan.contracts.length);
  assert.equal(second.created.partners ?? 0, 0);
  assert.equal(await db.item.count({ where: { companyId: actor.companyId } }), plan.items.length);
});

test('sigurnosna kopija: izvoz i vraćanje u novu firmu daju iste podatke', async () => {
  const actor = await actorCompany();
  const { r } = await importNew(fixture, actor);
  // prilozi preko više stranica izvoza (po 20) + jedan podmetnuti HTML koji se ne smije vratiti
  const item = await db.item.findFirstOrThrow({ where: { companyId: r.companyId }, select: { id: true } });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
  await db.attachment.createMany({
    data: Array.from({ length: 45 }, (_, i) => ({ companyId: r.companyId, entity: 'item', entityId: item.id, fileName: `n${i}.png`, mime: 'image/png', size: png.length, data: png })),
  });
  await db.attachment.create({
    data: { companyId: r.companyId, entity: 'item', entityId: item.id, fileName: 'x.png', mime: 'image/png', size: 5, data: new TextEncoder().encode('<svg onload=alert(1)>') },
  });
  const text = await new Response(await exportCompanyStream(r.companyId)).text();
  const raw = JSON.parse(text);
  assert.equal(raw.format, 'erp-wms-backup');
  assert.equal(raw.version, 1);
  assert.ok(!('passwordHash' in raw.users[0]));
  assert.equal(raw.items.length, await db.item.count({ where: { companyId: r.companyId } }));
  const plan = backupToPlan(raw);
  const restored = await runImport(plan, { target: { kind: 'new', name: `Vraćeno ${Date.now()}` }, actor, log: quiet });
  companies.push(restored.companyId);
  const sums = async (companyId: string) => {
    const a = await db.invoice.aggregate({ where: { companyId }, _sum: { grandTotal: true, openAmount: true, paidTotal: true }, _count: true });
    return [a._count, num(a._sum.grandTotal), num(a._sum.openAmount), num(a._sum.paidTotal)];
  };
  assert.deepEqual(await sums(restored.companyId), await sums(r.companyId));
  for (const m of ['item', 'contract', 'partner', 'expense', 'serviceOrder', 'quote', 'rentOverride'] as const) {
    const count = (companyId: string) => (db[m] as unknown as { count: (a: object) => Promise<number> }).count({ where: { companyId } });
    assert.equal(await count(restored.companyId), await count(r.companyId), m);
  }
  assert.equal(
    await db.contractItem.count({ where: { contract: { companyId: restored.companyId } } }),
    await db.contractItem.count({ where: { contract: { companyId: r.companyId } } }),
  );
  // brojači i povijest uređaja prenesu se
  const c1 = await db.documentCounter.findMany({ where: { companyId: r.companyId }, orderBy: [{ series: 'asc' }, { year: 'asc' }], select: { series: true, year: true, last: true } });
  const c2 = await db.documentCounter.findMany({ where: { companyId: restored.companyId }, orderBy: [{ series: 'asc' }, { year: 'asc' }], select: { series: true, year: true, last: true } });
  assert.deepEqual(c2, c1);
  assert.ok((await db.itemEvent.count({ where: { companyId: restored.companyId } })) >= 2 * plan.items.length);
  assert.equal(raw.attachments.length, 46);
  assert.equal(await db.attachment.count({ where: { companyId: restored.companyId } }), 45);
  assert.equal(await db.attachment.count({ where: { companyId: restored.companyId, mime: { not: 'image/png' } } }), 0);
  assert.equal(plan.warningCounts['attachment-invalid'], 1);
});
