/**
 * Ulazni eRačuni nad testnom bazom (demo posrednik, bez mreže): preuzimanje je
 * idempotentno, dobavljač se pronalazi ili otvara po OIB-u, prihvaćanje knjiži
 * trošak, odbijanje traži razlog i izbacuje račun iz zbrojeva, firme su odvojene.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import type { Actor } from '../../src/server/services/items';
import { acceptSupplierInvoice, markSupplierInvoicesPaid, rejectSupplierInvoice } from '../../src/server/services/inbound';
import { fetchIncoming } from '../../src/server/services/inbound-fetch';
import { deleteSupplierInvoice, saveSupplierInvoice } from '../../src/server/services/expenses';
import { listSupplierInvoices } from '../../src/server/queries/purchasing';
import { listAccountant } from '../../src/server/queries/accountant';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');
process.env.AUTH_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';

const companies: string[] = [];

async function setup(provider = 'demo') {
  const c = await db.company.create({ data: { name: `Ulazni ${Date.now()}-${Math.random()}`, oib: '12345678903', fiscalEnv: 'TEST', eInvoiceProvider: provider } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `u${Date.now()}${Math.random()}@t.hr`, name: 'Nabava', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  // postojeći partner (kupac) s OIB-om prvog demo dobavljača → mora postati dobavljač, ne duplikat
  const known = await db.partner.create({ data: { companyId: c.id, name: 'Distributer POS (od prije)', oib: '69435151530', isCustomer: true, isSupplier: false } });
  return { companyId: c.id, actor, known };
}

const list = (companyId: string, sp: Record<string, string> = {}) => listSupplierInvoices(companyId, sp, { skip: 0, take: 100 });

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

test('preuzimanje: zaprimljeni računi s XML-om i PDF-om, dobavljač po OIB-u; ponovno preuzimanje ništa ne dodaje', async () => {
  const s = await setup();
  const r1 = await fetchIncoming(s.actor);
  assert.deepEqual({ found: r1.found, created: r1.created, existing: r1.existing, failed: r1.failed, demo: r1.demo }, { found: 2, created: 2, existing: 0, failed: 0, demo: true });

  const rows = await db.supplierInvoice.findMany({ where: { companyId: s.companyId }, include: { supplier: true }, orderBy: { eInvoiceId: 'asc' } });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.source, 'EINVOICE');
    assert.equal(r.status, 'RECEIVED');
    assert.equal(r.eInvoiceEnv, 'TEST');
    assert.match(r.internalNo, /URA/);
  }
  const [a, b] = rows;
  assert.equal(a.eInvoiceId, 'DEMO-IN-1001');
  assert.equal(a.number, 'R-2041/1/1');
  assert.equal(Number(a.netAmount), 740);
  assert.equal(Number(a.vatAmount), 185);
  assert.equal(Number(a.total), 925);
  assert.equal(a.supplierId, s.known.id, 'postojeći partner s istim OIB-om');
  assert.equal(a.supplier.isSupplier, true);
  assert.equal(b.supplier.oib, '84123456785');
  assert.equal(b.supplier.name, 'Oblak Usluge j.d.o.o.');
  assert.equal(b.supplier.isSupplier, true);
  assert.equal(b.supplier.city, 'Rijeka');

  const att = await db.attachment.findMany({ where: { companyId: s.companyId, entity: 'supplierInvoice' }, select: { entityId: true, mime: true, fileName: true } });
  assert.deepEqual(att.filter((x) => x.entityId === a.id).map((x) => x.mime).sort(), ['application/pdf', 'application/xml']);
  assert.deepEqual(att.filter((x) => x.entityId === b.id).map((x) => x.mime), ['application/xml']);
  assert.equal(await db.expense.count({ where: { companyId: s.companyId } }), 0, 'zaprimljen račun još nije trošak');

  const r2 = await fetchIncoming(s.actor);
  assert.equal(r2.created, 0);
  assert.equal(r2.existing, 2);
  assert.equal(await db.supplierInvoice.count({ where: { companyId: s.companyId } }), 2);
  assert.equal(await db.partner.count({ where: { companyId: s.companyId } }), 2, 'drugi dobavljač otvoren samo jednom');
  const logs = await db.auditLog.findMany({ where: { companyId: s.companyId, entity: 'supplierInvoice', action: 'fetch' } });
  assert.equal(logs.length, 2);
});

test('prihvaćanje knjiži trošak; ponovno prihvaćanje se odbija', async () => {
  const s = await setup();
  await fetchIncoming(s.actor);
  const si = await db.supplierInvoice.findFirstOrThrow({ where: { companyId: s.companyId, eInvoiceId: 'DEMO-IN-1001' } });
  const r = await acceptSupplierInvoice(s.actor, si.id);
  assert.equal(r.reported, true);
  const after = await db.supplierInvoice.findUniqueOrThrow({ where: { id: si.id }, include: { expense: true } });
  assert.equal(after.status, 'ACCEPTED');
  assert.equal(after.statusBy, 'Nabava');
  assert.ok(after.statusAt);
  assert.equal(after.providerStatus, 'prihvaćen');
  assert.equal(Number(after.expense?.netAmount), 740);
  await assert.rejects(acceptSupplierInvoice(s.actor, si.id), /već prihvaćen/);
  assert.equal(await db.auditLog.count({ where: { companyId: s.companyId, entityId: si.id, action: 'accept' } }), 1);
  // prihvaćen eRačun se ne briše
  await assert.rejects(transaction((tx) => deleteSupplierInvoice(tx, s.actor, si.id)), /ne briše/);
});

test('odbijanje: razlog obvezan, izlazi iz zbrojeva, trošak se briše, ne može se platiti', async () => {
  const s = await setup();
  await fetchIncoming(s.actor);
  const [a, b] = await db.supplierInvoice.findMany({ where: { companyId: s.companyId }, orderBy: { eInvoiceId: 'asc' } });
  const before = await list(s.companyId);
  assert.equal(before.sums.total, 925 + Number(b.total));
  assert.equal(before.sums.unpaid, 925 + Number(b.total));

  await assert.rejects(rejectSupplierInvoice(s.actor, a.id, '  '), /razlog/);
  await acceptSupplierInvoice(s.actor, a.id);
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: a.id } }), 1);
  await rejectSupplierInvoice(s.actor, a.id, 'Neispravan iznos');
  const rej = await db.supplierInvoice.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(rej.status, 'REJECTED');
  assert.equal(rej.rejectReason, 'Neispravan iznos');
  assert.equal(rej.providerStatus, 'odbijen');
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: a.id } }), 0);
  await assert.rejects(rejectSupplierInvoice(s.actor, a.id, 'Opet'), /već odbijen/);
  await assert.rejects(acceptSupplierInvoice(s.actor, a.id), /Odbijeni/);

  const afterList = await list(s.companyId);
  assert.equal(afterList.total, 2, 'odbijen je i dalje na popisu');
  assert.equal(afterList.sums.total, Number(b.total));
  assert.equal(afterList.sums.unpaid, Number(b.total));
  assert.deepEqual((await list(s.companyId, { status: 'rejected' })).rows.map((r) => r.id), [a.id]);
  assert.deepEqual((await list(s.companyId, { status: 'received' })).rows.map((r) => r.id), [b.id]);
  assert.deepEqual((await list(s.companyId, { source: 'manual' })).rows, []);

  // knjigovođa: odbijeni nije isprava
  const acc = await listAccountant(s.companyId, { from: '2000-01-01', to: '2100-12-31', dir: 'in', sent: '', kind: '', q: '' });
  assert.equal(acc.totals.in.count, 1);
  assert.equal(acc.totals.in.total, Number(b.total));

  await assert.rejects(markSupplierInvoicesPaid(s.actor, [a.id], '2026-03-01'), /Odbijeni/);
  await assert.rejects(
    transaction((tx) =>
      saveSupplierInvoice(tx, s.actor, a.id, { supplierId: a.supplierId, number: a.number, issueDate: '2026-01-01', netAmount: 1, vatAmount: 0, paidDate: '2026-03-01', book: false }),
    ),
    /plaćenim/,
  );
  const audit = await db.auditLog.findFirstOrThrow({ where: { companyId: s.companyId, entityId: a.id, action: 'reject' } });
  assert.match(audit.summary, /Neispravan iznos/);
  assert.match(audit.summary, /Poreznoj upravi/);

  // plaćanje eRačuna: status „plaćen" posredniku (demo), bez upozorenja
  const paid = await markSupplierInvoicesPaid(s.actor, [b.id], '2026-03-05');
  assert.equal(paid.warning, null);
  const pb = await db.supplierInvoice.findUniqueOrThrow({ where: { id: b.id } });
  assert.equal(pb.providerStatus, 'plaćen');
  assert.deepEqual((await list(s.companyId, { status: 'paid' })).rows.map((r) => r.id), [b.id]);
  await assert.rejects(rejectSupplierInvoice(s.actor, b.id, 'Kasno'), /Plaćeni/);
});

test('eRačun: dobavljač, broj i iznosi se ne mijenjaju obrascem; ručni račun se odbija samo lokalno', async () => {
  const s = await setup();
  await fetchIncoming(s.actor);
  const a = await db.supplierInvoice.findFirstOrThrow({ where: { companyId: s.companyId, eInvoiceId: 'DEMO-IN-1001' } });
  await transaction((tx) =>
    saveSupplierInvoice(tx, s.actor, a.id, { supplierId: s.known.id, number: 'PROMIJENJEN', issueDate: '2020-01-01', netAmount: 1, vatAmount: 1, category: 'Oprema', book: false }),
  );
  const x = await db.supplierInvoice.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(x.number, 'R-2041/1/1');
  assert.equal(Number(x.total), 925);
  assert.equal(x.category, 'Oprema');

  // ručni račun: zadani status ACCEPTED (kao i svi postojeći), odbijanje bez posrednika
  const m = await transaction((tx) =>
    saveSupplierInvoice(tx, s.actor, null, { supplierId: s.known.id, number: 'RUC-1', issueDate: '2026-02-01', netAmount: 100, vatAmount: 25, book: true }),
  );
  const mr = await db.supplierInvoice.findUniqueOrThrow({ where: { id: m.id } });
  assert.equal(mr.source, 'MANUAL');
  assert.equal(mr.status, 'ACCEPTED');
  const r = await rejectSupplierInvoice(s.actor, m.id, 'Duplikat računa');
  assert.equal(r.reported, false);
  assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: m.id } })).status, 'REJECTED');
  assert.equal(await db.expense.count({ where: { supplierInvoiceId: m.id } }), 0);
});

test('firme su odvojene; bez posrednika preuzimanje javlja grešku', async () => {
  const s1 = await setup();
  const s2 = await setup();
  await fetchIncoming(s1.actor);
  await fetchIncoming(s2.actor);
  // isti id posrednika u dvije firme je dopušten
  assert.equal(await db.supplierInvoice.count({ where: { eInvoiceId: 'DEMO-IN-1001', companyId: { in: [s1.companyId, s2.companyId] } } }), 2);
  const foreign = await db.supplierInvoice.findFirstOrThrow({ where: { companyId: s2.companyId } });
  await assert.rejects(acceptSupplierInvoice(s1.actor, foreign.id), /ne postoji/);
  await assert.rejects(rejectSupplierInvoice(s1.actor, foreign.id, 'Tuđi račun'), /ne postoji/);
  await assert.rejects(markSupplierInvoicesPaid(s1.actor, [foreign.id], '2026-01-01'), /ne postoje/);
  assert.equal((await list(s1.companyId)).total, 2);

  const none = await setup('none');
  await assert.rejects(fetchIncoming(none.actor), /Posrednik za eRačun nije odabran/);
  const noKey = await setup('eposlovanje');
  await assert.rejects(fetchIncoming(noKey.actor), /API ključ/);
});
