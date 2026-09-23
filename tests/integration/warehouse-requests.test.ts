/**
 * Zahtjev za zaprimanje (RECEIVE) i prilozi nad pravom bazom (wms_test).  npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { receiveItems, resolveApproval } from '../../src/server/services/warehouse';
import { ackRequest, approveReceiveRequest, createReceiveRequest } from '../../src/server/services/receive-requests';
import { addAttachment, addAttachments, deleteAttachment, listAttachments, readAttachment } from '../../src/server/services/attachments';
import { approvalRequests, unseenRejections } from '../../src/server/queries/approvals';
import { fromISO } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
/** Najmanji „JPEG" — dovoljan za provjeru vrste po sadržaju. */
const jpeg = (n = 16) => {
  const b = new Uint8Array(n);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};

async function setup(tag: string) {
  const c = await db.company.create({ data: { name: `Req ${tag} ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const mkUser = async (name: string) => {
    const u = await db.user.create({ data: { companyId: c.id, email: `${tag}${Date.now()}${Math.random()}@t.hr`, name, passwordHash: 'x', role: 'ADMIN' } });
    return { id: u.id, name: u.name, companyId: c.id } satisfies Actor;
  };
  const admin = await mkUser('Admin');
  const ops = await mkUser('Ana Skladištar');
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Zebra', name: 'TC21' } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const wh2 = await db.warehouse.create({ data: { companyId: c.id, name: 'Drugo skladište' } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const sold = await transaction((tx) => statusFor(tx, c.id, 'SOLD'));
  const mk = (serial: string, over: Record<string, unknown> = {}) =>
    db.item.create({
      data: { companyId: c.id, serial, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 50, importDate: fromISO('2026-01-01'), ...over },
    });
  const items = {
    inStock: await mk(`${tag}-STOCK`),
    sold: await mk(`${tag}-SOLD`, { statusId: sold.id, state: 'SOLD', warehouseId: null, partnerId: partner.id }),
  };
  return { companyId: c.id, admin, ops, model, wh, wh2, items };
}

const receiveInput = (s: Awaited<ReturnType<typeof setup>>, serials: string[], warehouseId: string) => ({
  modelId: s.model.id,
  warehouseId,
  supplierId: null,
  cost: 10,
  importDate: '2026-09-01',
  supplierDocNumber: null,
  note: null,
  serials,
  skipExisting: true,
  dupNote: null,
});

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

test('zahtjev za zaprimanje: slanje → zaprimanje odobrava zahtjev, vraća poznate i prenosi slike', async () => {
  const s = await setup('rq1');
  const r = await transaction((tx) =>
    createReceiveRequest(tx, s.ops, {
      serials: ['RQ1-NEW-1', ' RQ1-NEW-2 ', 'RQ1-NEW-1'],
      returning: [s.items.sold.id],
      warehouseId: s.wh.id,
      note: 'Otpremnica 12',
      photos: [
        { code: 'RQ1-NEW-1', itemId: null, fileName: 'naljepnica RQ1-NEW-1', data: jpeg() },
        { code: null, itemId: s.items.sold.id, fileName: 'povrat.jpg', data: jpeg() },
        { code: null, itemId: null, fileName: 'kutija.jpg', data: jpeg() },
      ],
    }),
  );
  const req = await db.approvalRequest.findUniqueOrThrow({ where: { id: r.id } });
  assert.equal(req.kind, 'RECEIVE');
  assert.equal(req.status, 'PENDING');
  assert.equal(req.requestedBy, 'Ana Skladištar');
  const payload = req.payload as { serials: string[]; returning: string[]; photos: Array<{ id: string; code: string | null; itemId: string | null }>; requesterId: string };
  assert.deepEqual(payload.serials, ['RQ1-NEW-1', 'RQ1-NEW-2']);
  assert.deepEqual(payload.returning, [s.items.sold.id]);
  assert.equal(payload.requesterId, s.ops.id);
  assert.equal(payload.photos.length, 3);
  assert.equal((await listAttachments(db, s.companyId, 'request', [r.id])).length, 3);
  // uređaji još ne postoje
  assert.equal(await db.item.count({ where: { companyId: s.companyId, serial: { startsWith: 'RQ1-NEW' } } }), 0);

  // stranica Odobrenja: administrator vidi zahtjev, skladištar ga vidi među svojima
  const all = await approvalRequests(s.companyId);
  const row = all.pending.find((x) => x.id === r.id);
  assert.ok(row && row.kind === 'RECEIVE');
  assert.deepEqual(row.serials, ['RQ1-NEW-1', 'RQ1-NEW-2']);
  assert.equal(row.items[0].id, s.items.sold.id);
  assert.equal(row.photos.find((p) => p.code === 'RQ1-NEW-1')?.mime, 'image/jpeg');
  assert.equal((await approvalRequests(s.companyId, { mine: { id: s.ops.id, name: s.ops.name } })).pending.length, 1);
  assert.equal((await approvalRequests(s.companyId, { mine: { id: s.admin.id, name: s.admin.name } })).pending.length, 0);

  // „Provjeri i zaprimi": primka + odobrenje u jednoj transakciji, u drugo skladište
  const res = await transaction(async (tx) => {
    const rec = await receiveItems(tx, s.admin, receiveInput(s, payload.serials, s.wh2.id));
    return approveReceiveRequest(tx, s.admin, r.id, { warehouseId: s.wh2.id, receiptId: rec.receiptId, receiptNumber: rec.number });
  });
  assert.equal(res.created, 2);
  assert.equal(res.returned, 1);
  assert.equal(res.photos, 2);

  const done = await db.approvalRequest.findUniqueOrThrow({ where: { id: r.id } });
  assert.equal(done.status, 'APPROVED');
  assert.equal(done.resolvedBy, 'Admin');
  assert.ok(done.resolvedAt);
  assert.match(done.resolveNote ?? '', /primka/);

  const created = await db.item.findMany({ where: { companyId: s.companyId, serial: { startsWith: 'RQ1-NEW' } }, orderBy: { serial: 'asc' } });
  assert.deepEqual(created.map((i) => [i.serial, i.state, i.warehouseId]), [
    ['RQ1-NEW-1', 'IN_STOCK', s.wh2.id],
    ['RQ1-NEW-2', 'IN_STOCK', s.wh2.id],
  ]);
  const back = await db.item.findUniqueOrThrow({ where: { id: s.items.sold.id } });
  assert.equal(back.state, 'IN_STOCK');
  assert.equal(back.warehouseId, s.wh2.id);
  assert.equal(back.partnerId, null);
  assert.ok(await db.itemEvent.findFirst({ where: { itemId: back.id, type: 'RETURNED' } }));

  // slike naljepnica prešle su na uređaje (kopija sadržaja), slika zahtjeva ostaje
  const onNew = await listAttachments(db, s.companyId, 'item', [created[0].id]);
  assert.equal(onNew.length, 1);
  assert.equal(onNew[0].mime, 'image/jpeg');
  assert.equal((await readAttachment(db, s.companyId, onNew[0].id))?.data.byteLength, 16);
  assert.equal((await listAttachments(db, s.companyId, 'item', [back.id])).length, 1);
  assert.equal((await listAttachments(db, s.companyId, 'item', [created[1].id])).length, 0);
  assert.equal((await listAttachments(db, s.companyId, 'request', [r.id])).length, 3);

  // ne može se riješiti dvaput
  await assert.rejects(transaction((tx) => approveReceiveRequest(tx, s.admin, r.id, { warehouseId: s.wh.id })), /već riješen/);
  await assert.rejects(transaction((tx) => resolveApproval(tx, s.admin, r.id, false, 'kasno')), /već riješen/);
});

test('zahtjev za zaprimanje: odbijanje s razlogom, potvrda podnositelja, bez uređaja', async () => {
  const s = await setup('rq2');
  const r = await transaction((tx) => createReceiveRequest(tx, s.ops, { serials: ['RQ2-A'], returning: [], warehouseId: s.wh.id, note: null, photos: [] }));
  // odobrava se samo zaprimanjem, ne generičkim „Odobri"
  await assert.rejects(transaction((tx) => resolveApproval(tx, s.admin, r.id, true, null)), /zaprimanjem/);
  // novi serijski se ne mogu „samo vratiti"
  await assert.rejects(transaction((tx) => approveReceiveRequest(tx, s.admin, r.id, { warehouseId: s.wh.id })), /Provjeri i zaprimi/);
  await assert.rejects(transaction((tx) => resolveApproval(tx, s.admin, r.id, false, null)), /razlog/);

  await transaction((tx) => resolveApproval(tx, s.admin, r.id, false, 'Krivi model na naljepnici'));
  const rej = await db.approvalRequest.findUniqueOrThrow({ where: { id: r.id } });
  assert.equal(rej.status, 'REJECTED');
  assert.equal(rej.resolveNote, 'Krivi model na naljepnici');
  assert.equal(await db.item.count({ where: { companyId: s.companyId, serial: 'RQ2-A' } }), 0);

  // skladištar vidi odbijanje (traka na skeniranju) dok ga ne potvrdi
  const seen = await unseenRejections(s.companyId, s.ops);
  assert.deepEqual(seen.map((x) => [x.id, x.resolveNote, x.count]), [[r.id, 'Krivi model na naljepnici', 1]]);
  assert.equal((await unseenRejections(s.companyId, s.admin)).length, 0);
  await assert.rejects(transaction((tx) => ackRequest(tx, s.admin, r.id)), /podnositelj/);
  await transaction((tx) => ackRequest(tx, s.ops, r.id));
  assert.equal((await unseenRejections(s.companyId, s.ops)).length, 0);
  const mine = await approvalRequests(s.companyId, { mine: s.ops });
  assert.equal(mine.resolved[0].id, r.id);
  assert.equal(mine.resolved[0].ack, true);

  // zahtjev samo s poznatim uređajima: odobrava se povratom na skladište
  const r2 = await transaction((tx) => createReceiveRequest(tx, s.ops, { serials: [], returning: [s.items.sold.id], warehouseId: s.wh.id, note: null, photos: [] }));
  const res = await transaction((tx) => approveReceiveRequest(tx, s.admin, r2.id, { warehouseId: s.wh2.id }));
  assert.equal(res.returned, 1);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: s.items.sold.id } })).warehouseId, s.wh2.id);
  assert.equal((await db.approvalRequest.findUniqueOrThrow({ where: { id: r2.id } })).status, 'APPROVED');
});

test('zahtjev za zaprimanje: provjere ulaza', async () => {
  const s = await setup('rq3');
  const create = (over: Partial<Parameters<typeof createReceiveRequest>[2]>) =>
    transaction((tx) => createReceiveRequest(tx, s.ops, { serials: [], returning: [], warehouseId: s.wh.id, note: null, photos: [], ...over }));
  await assert.rejects(create({}), /Nema ničega/);
  await assert.rejects(create({ returning: [s.items.inStock.id] }), /ne vraćaju na skladište/);
  await assert.rejects(create({ serials: [s.items.inStock.serial] }), /već postoje/);
  await assert.rejects(create({ serials: ['RQ3-X'], warehouseId: 'nepostoji' }), /Skladište ne postoji/);
  await assert.rejects(create({ serials: ['RQ3-X'], photos: [{ code: 'RQ3-X', itemId: null, fileName: 'x.jpg', data: new TextEncoder().encode('<html>') }] }), /nije slika/);
  // neuspjelo slanje ne ostavlja zahtjev
  assert.equal(await db.approvalRequest.count({ where: { companyId: s.companyId } }), 0);
});

test('prilozi: izolacija firmi, vrsta, veličina i najveći broj', async () => {
  const a = await setup('atA');
  const b = await setup('atB');
  const att = await transaction((tx) => addAttachment(tx, a.admin, { entity: 'item', entityId: a.items.inStock.id, fileName: 'naljepnica.jpg', data: jpeg() }));
  assert.equal(att.mime, 'image/jpeg');
  assert.equal(att.fileName, 'naljepnica.jpg');

  // druga firma ne vidi, ne briše i ne dodaje tuđim zapisima
  assert.equal(await readAttachment(db, b.companyId, att.id), null);
  assert.ok(await readAttachment(db, a.companyId, att.id));
  assert.equal((await listAttachments(db, b.companyId, 'item', [a.items.inStock.id])).length, 0);
  await assert.rejects(transaction((tx) => deleteAttachment(tx, b.admin, att.id)), /ne postoji/);
  await assert.rejects(
    transaction((tx) => addAttachment(tx, b.admin, { entity: 'item', entityId: a.items.inStock.id, fileName: 'x.jpg', data: jpeg() })),
    /ne postoji/,
  );
  await assert.rejects(
    transaction((tx) => createReceiveRequest(tx, b.ops, { serials: [], returning: [a.items.sold.id], warehouseId: b.wh.id, note: null, photos: [] })),
    /ne postoje/,
  );

  // vrsta po sadržaju, veličina i broj
  await assert.rejects(
    transaction((tx) => addAttachment(tx, a.admin, { entity: 'item', entityId: a.items.inStock.id, fileName: 'slika.jpg', data: new TextEncoder().encode('<script>') })),
    /nije slika/,
  );
  await assert.rejects(
    transaction((tx) => addAttachment(tx, a.admin, { entity: 'item', entityId: a.items.inStock.id, fileName: 'velika.jpg', data: jpeg(2 * 1024 * 1024 + 1) })),
    /veća od 2 MB/,
  );
  await transaction((tx) => addAttachments(tx, a.admin, 'item', a.items.inStock.id, Array.from({ length: 9 }, (_, i) => ({ fileName: `s${i}.jpg`, data: jpeg() }))));
  await assert.rejects(
    transaction((tx) => addAttachment(tx, a.admin, { entity: 'item', entityId: a.items.inStock.id, fileName: 'jedanaesta.jpg', data: jpeg() })),
    /Najviše 10/,
  );

  await transaction((tx) => deleteAttachment(tx, a.admin, att.id));
  assert.equal(await readAttachment(db, a.companyId, att.id), null);
});
