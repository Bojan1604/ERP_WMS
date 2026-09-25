/**
 * Područje E — odobravanje zahtjeva za zaprimanje po retku (model po kodu,
 * ispravak serijskog broja, preskakanje reda) nad testnom bazom.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { addAttachments } from '../../src/server/services/attachments';
import { approveReceiveRows, createReceiveRequest, type ReceiveReviewInput } from '../../src/server/services/receive-requests';
import { fromISO } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
const jpeg = () => {
  const b = new Uint8Array(16);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};

async function setup(tag: string) {
  const c = await db.company.create({ data: { name: `E-req ${tag} ${Date.now()}-${Math.random()}` } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const mk = async (name: string) => {
    const u = await db.user.create({ data: { companyId: c.id, email: `er${tag}${name}${Date.now()}${Math.random()}@t.hr`, name, passwordHash: 'x', role: 'ADMIN' } });
    return { id: u.id, name: u.name, companyId: c.id } satisfies Actor;
  };
  const admin = await mk('Admin');
  const ops = await mk('Skladištar');
  const m1 = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Zebra', name: `TC21-${tag}`, os: 'Android 10' } });
  const m2 = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Zebra', name: `TC26-${tag}` } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac' } });
  const sold = await transaction((tx) => statusFor(tx, c.id, 'SOLD'));
  const back = await db.item.create({
    data: { companyId: c.id, serial: `${tag}-BACK`, modelId: m1.id, statusId: sold.id, state: 'SOLD', partnerId: partner.id, cost: 10, importDate: fromISO('2026-01-01') },
  });
  const back2 = await db.item.create({
    data: { companyId: c.id, serial: `${tag}-BACK2`, modelId: m1.id, statusId: sold.id, state: 'SOLD', partnerId: partner.id, cost: 10, importDate: fromISO('2026-01-01') },
  });
  return { companyId: c.id, admin, ops, m1, m2, wh, back, back2 };
}
type S = Awaited<ReturnType<typeof setup>>;

const review = (s: S, over: Partial<ReceiveReviewInput>): ReceiveReviewInput => ({
  warehouseId: s.wh.id,
  supplierId: null,
  cost: 40,
  importDate: '2026-09-01',
  supplierDocNumber: 'OTP-1',
  note: null,
  bookExpense: true,
  rows: [],
  skipReturning: [],
  ...over,
});

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

test('po retku: model po kodu, ispravak serijskog (slika prelazi na uređaj), preskočen red i preskočen povrat', async () => {
  const s = await setup('rows');
  const req = await transaction((tx) =>
    createReceiveRequest(tx, s.ops, { serials: ['A-1', 'A-2', 'A-3'], returning: [s.back.id, s.back2.id], warehouseId: s.wh.id, note: 'kamion', photos: [] }),
  );
  // slika naljepnice uz kod A-2 (koji će administrator ispraviti u A-2X)
  const [att] = await transaction((tx) => addAttachments(tx, s.ops, 'request', req.id, [{ fileName: 'naljepnica A-2', data: jpeg() }]));
  const r0 = await db.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
  await db.approvalRequest.update({ where: { id: req.id }, data: { payload: { ...(r0.payload as object), photos: [{ id: att.id, code: 'A-2', itemId: null }] } } });

  // bez modela za redak koji se zaprima → greška
  await assert.rejects(
    transaction((tx) => approveReceiveRows(tx, s.admin, req.id, review(s, { rows: [{ code: 'A-1', serial: 'A-1', modelId: null, skip: false }, { code: 'A-2', serial: 'A-2', modelId: s.m1.id, skip: false }, { code: 'A-3', serial: 'A-3', modelId: null, skip: true }] }))),
    /odaberite model/,
  );
  // nedostaje odluka za kod
  await assert.rejects(transaction((tx) => approveReceiveRows(tx, s.admin, req.id, review(s, { rows: [{ code: 'A-1', serial: 'A-1', modelId: s.m1.id, skip: false }] }))), /Nedostaje odluka/);

  const r = await transaction((tx) =>
    approveReceiveRows(
      tx,
      s.admin,
      req.id,
      review(s, {
        rows: [
          { code: 'A-1', serial: 'A-1', modelId: s.m1.id, skip: false },
          { code: 'A-2', serial: ' A-2X ', modelId: s.m2.id, skip: false },
          { code: 'A-3', serial: 'A-3', modelId: null, skip: true },
        ],
        skipReturning: [s.back2.id],
      }),
    ),
  );
  assert.equal(r.created, 2);
  assert.equal(r.returned, 1);
  assert.equal(r.skipped, 2);
  const items = await db.item.findMany({ where: { companyId: s.companyId, receiptId: r.receiptId! }, orderBy: { serial: 'asc' } });
  assert.deepEqual(items.map((i) => [i.serial, i.modelId]), [['A-1', s.m1.id], ['A-2X', s.m2.id]]);
  assert.equal(items[0].os, 'Android 10', 'specifikacije s modela');
  assert.equal(await db.item.count({ where: { companyId: s.companyId, serial: 'A-3' } }), 0, 'preskočeni red ne nastaje');
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: s.back.id } })).state, 'IN_STOCK');
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: s.back2.id } })).state, 'SOLD', 'preskočeni povrat ostaje gdje jest');
  // slika uz ispravljeni serijski prelazi na novi uređaj
  const a2 = items.find((i) => i.serial === 'A-2X')!;
  assert.equal(await db.attachment.count({ where: { companyId: s.companyId, entity: 'item', entityId: a2.id } }), 1);
  // primka po modelima, jedan trošak nabave
  const receipt = await db.goodsReceipt.findUniqueOrThrow({ where: { id: r.receiptId! }, include: { expense: true } });
  assert.equal(Number(receipt.total), 80);
  assert.equal(Number(receipt.expense?.netAmount), 80);
  const done = await db.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
  assert.equal(done.status, 'APPROVED');
  assert.match(done.resolveNote ?? '', /preskočeno 2/);
});

test('po retku: sve preskočeno se odbija; bez knjiženja nabave nema troška; ponovljeni serijski se odbija', async () => {
  const s = await setup('skip');
  const req = await transaction((tx) => createReceiveRequest(tx, s.ops, { serials: ['B-1', 'B-2'], returning: [], warehouseId: s.wh.id, note: null, photos: [] }));
  await assert.rejects(
    transaction((tx) => approveReceiveRows(tx, s.admin, req.id, review(s, { rows: [{ code: 'B-1', serial: 'B-1', modelId: null, skip: true }, { code: 'B-2', serial: 'B-2', modelId: null, skip: true }] }))),
    /Svi redovi su preskočeni/,
  );
  await assert.rejects(
    transaction((tx) =>
      approveReceiveRows(tx, s.admin, req.id, review(s, { rows: [{ code: 'B-1', serial: 'X', modelId: s.m1.id, skip: false }, { code: 'B-2', serial: 'X', modelId: s.m1.id, skip: false }] })),
    ),
    /više puta/,
  );
  const r = await transaction((tx) =>
    approveReceiveRows(
      tx,
      s.admin,
      req.id,
      review(s, { bookExpense: false, rows: [{ code: 'B-1', serial: 'B-1', modelId: s.m1.id, skip: false }, { code: 'B-2', serial: 'B-2', modelId: s.m1.id, skip: true }] }),
    ),
  );
  assert.equal(r.created, 1);
  assert.equal(await db.expense.count({ where: { receiptId: r.receiptId! } }), 0);
  // drugi put se isti zahtjev ne može odobriti
  await assert.rejects(transaction((tx) => approveReceiveRows(tx, s.admin, req.id, review(s, { rows: [] }))), /već riješen/);
});
