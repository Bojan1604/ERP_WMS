/**
 * Integracijski testovi portala za klijente: prijava i sesija, izolacija
 * podataka po partneru i firmi (uređaji, nalozi, prilozi, nalog za dostavu),
 * prijava kvara i brojač novih prijava. Zasebna testna baza: npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { changeServiceStatus } from '../../src/server/services/service';
import { authenticatePortalUser, createPortalSession, resolvePortalSession, revokePortalSession, type PortalScope } from '../../src/server/portal/session';
import { createPortalUser, deletePortalUser, resetPortalPassword, setPortalUserActive, updatePortalUser } from '../../src/server/portal/users';
import { reportFault } from '../../src/server/portal/report';
import { portalNewCount } from '../../src/server/portal/count';
import {
  exportPortalDevices, listPortalDevices, listPortalOrders, parsePortalDeviceFilters, portalAttachment, portalDeliveryNote, portalDevice, portalModels, portalOrder,
} from '../../src/server/portal/queries';
import { addMonths, fromISO, today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');

const companies: string[] = [];
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = () => new Uint8Array([...Buffer.from('%PDF-1.4 test')]);
const noFilters = parsePortalDeviceFilters(new URLSearchParams());
const page = { skip: 0, take: 50 };

async function company() {
  const c = await db.company.create({ data: { name: `Portal ${Date.now()}-${Math.random()}`, invoicePremises: 'T1' } });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `d${Date.now()}${Math.random()}@t.hr`, name: 'Djelatnik', passwordHash: 'x', role: 'ADMIN' } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'V2', warrantyMonths: 24 } });
  const st = async (k: 'IN_STOCK' | 'SOLD' | 'RENTED' | 'WRITTEN_OFF') => (await transaction((tx) => statusFor(tx, c.id, k))).id;
  const statuses = { IN_STOCK: await st('IN_STOCK'), SOLD: await st('SOLD'), RENTED: await st('RENTED'), WRITTEN_OFF: await st('WRITTEN_OFF') };
  const item = (partnerId: string | null, state: keyof typeof statuses, serial: string, issueDate: string | null) =>
    db.item.create({ data: { companyId: c.id, serial, modelId: model.id, statusId: statuses[state], state, partnerId, issueDate: issueDate ? fromISO(issueDate) : null, cost: 50 } });
  return { companyId: c.id, actor, model, item };
}

async function portalUserFor(s: Awaited<ReturnType<typeof company>>, partnerId: string, email: string) {
  const created = await transaction((tx) => createPortalUser(tx, s.actor, { partnerId, name: 'Klijent', email }));
  const scope: PortalScope = { id: created.id, companyId: s.companyId, partnerId, name: 'Klijent', email: created.email };
  return { ...created, scope };
}

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

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

test('portal: prijava, sesija, isključivanje, nova lozinka, promjena adrese', async () => {
  const s = await company();
  const partner = await db.partner.create({ data: { companyId: s.companyId, name: 'Kupac A' } });
  const email = `Klijent${uniq()}@Firma.hr`;
  const pu = await portalUserFor(s, partner.id, email);
  assert.equal(pu.email, email.toLowerCase());
  assert.ok(pu.password.length >= 12);
  const stored = await db.portalUser.findUniqueOrThrow({ where: { id: pu.id } });
  assert.notEqual(stored.passwordHash, pu.password);
  assert.match(stored.passwordHash, /^\$2[aby]\$/, 'lozinka je bcrypt sažetak');

  assert.equal(await authenticatePortalUser(email, 'kriva-lozinka'), null);
  assert.equal(await authenticatePortalUser(`nepostoji${uniq()}@x.hr`, pu.password), null);
  const ok = await authenticatePortalUser(`  ${email.toUpperCase()} `, pu.password);
  assert.equal(ok?.id, pu.id);

  const { token } = await createPortalSession(pu.id, { ip: '1.2.3.4', userAgent: 'test' });
  const session = await db.portalSession.findFirstOrThrow({ where: { portalUserId: pu.id } });
  assert.notEqual(session.tokenHash, token, 'u bazi je samo sažetak tokena');
  const me = await resolvePortalSession(token);
  assert.equal(me?.partnerId, partner.id);
  assert.equal(me?.partnerName, 'Kupac A');
  assert.ok((await db.portalUser.findUniqueOrThrow({ where: { id: pu.id } })).lastLoginAt);
  assert.equal(await resolvePortalSession('krivi-token'), null);

  // isključen pristup: sesija i prijava prestaju vrijediti
  await transaction((tx) => setPortalUserActive(tx, s.actor, pu.id, false));
  assert.equal(await resolvePortalSession(token), null);
  assert.equal(await authenticatePortalUser(email, pu.password), null);
  await transaction((tx) => setPortalUserActive(tx, s.actor, pu.id, true));
  assert.equal(await resolvePortalSession(token), null, 'opozvana sesija ostaje opozvana');

  // nova lozinka: stara ne vrijedi, sesije se odjavljuju
  const t2 = (await createPortalSession(pu.id)).token;
  const reset = await transaction((tx) => resetPortalPassword(tx, s.actor, pu.id));
  assert.equal(await authenticatePortalUser(email, pu.password), null);
  assert.equal((await authenticatePortalUser(email, reset.password))?.id, pu.id);
  assert.equal(await resolvePortalSession(t2), null);

  // odjava
  const t3 = (await createPortalSession(pu.id)).token;
  await revokePortalSession(t3);
  assert.equal(await resolvePortalSession(t3), null);

  // istekla sesija
  const t4 = (await createPortalSession(pu.id)).token;
  await db.portalSession.updateMany({ where: { portalUserId: pu.id, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await resolvePortalSession(t4), null);

  // promjena adrese
  const newEmail = `novi${uniq()}@firma.hr`;
  await transaction((tx) => updatePortalUser(tx, s.actor, pu.id, { name: 'Novo Ime', email: newEmail }));
  assert.equal((await authenticatePortalUser(newEmail, reset.password))?.id, pu.id);
  assert.equal(await authenticatePortalUser(email, reset.password), null);

  // audit
  const logs = await db.auditLog.findMany({ where: { companyId: s.companyId, entity: 'portalUser', entityId: pu.id } });
  assert.ok(logs.length >= 5);
  assert.ok(!logs.some((l) => JSON.stringify(l).includes(reset.password)), 'lozinka ne ide u dnevnik');
});

test('portal: djelatnik ne može otvoriti pristup za partnera druge firme ni dvaput istu adresu', async () => {
  const a = await company();
  const b = await company();
  const pb = await db.partner.create({ data: { companyId: b.companyId, name: 'Tuđi partner' } });
  await assert.rejects(transaction((tx) => createPortalUser(tx, a.actor, { partnerId: pb.id, name: null, email: `x${uniq()}@t.hr` })), /Partner ne postoji/);
  const pa = await db.partner.create({ data: { companyId: a.companyId, name: 'Naš partner' } });
  const email = `dup${uniq()}@t.hr`;
  const pu = await portalUserFor(a, pa.id, email);
  await assert.rejects(transaction((tx) => createPortalUser(tx, a.actor, { partnerId: pa.id, name: null, email: email.toUpperCase() })), /već ima pristup/);
  // druga firma ne može dirati tuđi pristup
  await assert.rejects(transaction((tx) => setPortalUserActive(tx, b.actor, pu.id, false)), /ne postoji/);
  await assert.rejects(transaction((tx) => resetPortalPassword(tx, b.actor, pu.id)), /ne postoji/);
  await assert.rejects(transaction((tx) => deletePortalUser(tx, b.actor, pu.id)), /ne postoji/);
  await transaction((tx) => deletePortalUser(tx, a.actor, pu.id));
  assert.equal(await db.portalUser.count({ where: { id: pu.id } }), 0);
});

test('portal: klijent vidi samo svoje aktivne uređaje; filtri jamstva, modela i datuma; izvoz', async () => {
  const s = await company();
  const pa = await db.partner.create({ data: { companyId: s.companyId, name: 'A' } });
  const pb = await db.partner.create({ data: { companyId: s.companyId, name: 'B' } });
  const recent = addMonths(today(), -2);
  const old = addMonths(today(), -30);
  const rented = await s.item(pa.id, 'RENTED', `R${uniq()}`, recent);
  const sold = await s.item(pa.id, 'SOLD', `S${uniq()}`, old);
  const noDate = await s.item(pa.id, 'SOLD', `N${uniq()}`, null);
  await s.item(pa.id, 'IN_STOCK', `I${uniq()}`, recent); // skriven: na skladištu
  await s.item(pa.id, 'WRITTEN_OFF', `W${uniq()}`, recent); // skriven: otpisan
  const foreign = await s.item(pb.id, 'RENTED', `B${uniq()}`, recent);
  const other = await company();
  const po = await db.partner.create({ data: { companyId: other.companyId, name: 'Druga firma' } });
  await other.item(po.id, 'RENTED', `O${uniq()}`, recent);

  const { scope } = await portalUserFor(s, pa.id, `dev${uniq()}@t.hr`);
  const all = await listPortalDevices(scope, noFilters, page);
  assert.deepEqual(new Set(all.rows.map((r) => r.id)), new Set([rented.id, sold.id, noDate.id]));
  assert.equal(all.total, 3);
  assert.equal(all.all, 3);
  assert.equal(all.stats.rented, 1);
  assert.equal(all.stats.sold, 2);
  assert.equal(all.stats.inWarranty, 1);

  const f = (q: string) => parsePortalDeviceFilters(new URLSearchParams(q));
  assert.deepEqual((await listPortalDevices(scope, f('jamstvo=u'), page)).rows.map((r) => r.id), [rented.id]);
  assert.deepEqual((await listPortalDevices(scope, f('jamstvo=isteklo'), page)).rows.map((r) => r.id), [sold.id]);
  assert.deepEqual((await listPortalDevices(scope, f('jamstvo=bez'), page)).rows.map((r) => r.id), [noDate.id]);
  assert.deepEqual((await listPortalDevices(scope, f(`od=${addMonths(today(), -3)}`), page)).rows.map((r) => r.id), [rented.id]);
  assert.equal((await listPortalDevices(scope, f(`q=${sold.serial}`), page)).total, 1);
  assert.equal((await listPortalDevices(scope, f(`model=${s.model.id}`), page)).total, 3);
  // tuđi serijski broj u pretrazi ne daje ništa
  assert.equal((await listPortalDevices(scope, f(`q=${foreign.serial}`), page)).total, 0);
  assert.equal((await exportPortalDevices(scope, noFilters)).length, 3);
  assert.deepEqual((await portalModels(scope)).map((m) => m.value), [s.model.id]);
  assert.equal(await portalDevice(scope, foreign.id), null);
  assert.equal((await portalDevice(scope, rented.id))?.warrantyEnd, addMonths(recent, 24));
});

test('portal: prijava kvara otvara nalog „Prijavljeno" izvora portal s fotografijama; tuđi uređaj se odbija', async () => {
  const s = await company();
  const pa = await db.partner.create({ data: { companyId: s.companyId, name: 'A' } });
  const pb = await db.partner.create({ data: { companyId: s.companyId, name: 'B' } });
  const mine = await s.item(pa.id, 'RENTED', `M${uniq()}`, addMonths(today(), -1));
  const foreign = await s.item(pb.id, 'RENTED', `F${uniq()}`, addMonths(today(), -1));
  const stock = await s.item(pa.id, 'IN_STOCK', `K${uniq()}`, null);
  const ua = await portalUserFor(s, pa.id, `ra${uniq()}@t.hr`);
  const ub = await portalUserFor(s, pb.id, `rb${uniq()}@t.hr`);

  await assert.rejects(transaction((tx) => reportFault(tx, ua.scope, { itemId: foreign.id, issue: 'x', contact: null })), /Uređaj ne postoji/);
  await assert.rejects(transaction((tx) => reportFault(tx, ua.scope, { itemId: stock.id, issue: 'x', contact: null })), /Uređaj ne postoji/);
  await assert.rejects(transaction((tx) => reportFault(tx, ua.scope, { itemId: mine.id, issue: '   ', contact: null })), /Opišite kvar/);
  await assert.rejects(
    transaction((tx) => reportFault(tx, ua.scope, { itemId: mine.id, issue: 'x', contact: null }, Array.from({ length: 5 }, () => ({ fileName: 'a.png', data: PNG() })))),
    /Najviše 4/,
  );
  await assert.rejects(transaction((tx) => reportFault(tx, ua.scope, { itemId: mine.id, issue: 'x', contact: null }, [{ fileName: 'a.pdf', data: PDF() }])), /nije slika/);
  assert.equal(await db.serviceOrder.count({ where: { companyId: s.companyId } }), 0, 'odbijene prijave ne ostavljaju nalog');

  assert.equal(await portalNewCount(s.companyId), 0);
  const order = await transaction((tx) =>
    reportFault(tx, { ...ua.scope, partnerName: 'A' }, { itemId: mine.id, issue: 'Ekran ne reagira', contact: '091 123 4567' }, [
      { fileName: 'kvar.png', data: PNG() },
      { fileName: 'kvar2.png', data: PNG() },
    ]),
  );
  const o = await db.serviceOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(o.status, 'REPORTED');
  assert.equal(o.source, 'PORTAL');
  assert.equal(o.portalUserId, ua.id);
  assert.equal(o.contact, '091 123 4567');
  assert.equal(o.partnerId, pa.id);
  assert.equal(o.underWarranty, true);
  assert.equal(o.receivedAt, null);
  assert.equal(await db.attachment.count({ where: { entity: 'serviceOrder', entityId: o.id } }), 2);
  // uređaj ostaje u najmu dok ga servis ne zaprimi
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: mine.id } })).state, 'RENTED');
  assert.ok(await db.auditLog.findFirst({ where: { companyId: s.companyId, entity: 'service', entityId: o.id, action: 'portal' } }));
  // drugi otvoren nalog za isti uređaj nije moguć
  await assert.rejects(transaction((tx) => reportFault(tx, ua.scope, { itemId: mine.id, issue: 'opet', contact: null })), /već ima otvoren servisni nalog/);

  // brojač novih prijava i značka
  assert.equal(await portalNewCount(s.companyId), 1);
  const other = await company();
  assert.equal(await portalNewCount(other.companyId), 0);

  // uređaj na popisu pokazuje otvoren nalog
  const list = await listPortalDevices(ua.scope, noFilters, page);
  assert.equal(list.rows.find((r) => r.id === mine.id)?.serviceOrders[0]?.id, o.id);
  assert.equal(list.stats.inService, 1);

  // --- izolacija: klijent B ne vidi nalog, fotografije ni nalog za dostavu klijenta A
  const photo = await db.attachment.findFirstOrThrow({ where: { entity: 'serviceOrder', entityId: o.id } });
  assert.ok(await portalOrder(ua.scope, o.id));
  assert.equal((await portalOrder(ua.scope, o.id))?.photos.length, 2);
  assert.ok(await portalAttachment(ua.scope, photo.id));
  assert.ok(await portalDeliveryNote(ua.scope, o.id));
  assert.equal((await listPortalOrders(ua.scope, page)).total, 1);

  assert.equal(await portalOrder(ub.scope, o.id), null);
  assert.equal(await portalAttachment(ub.scope, photo.id), null);
  assert.equal(await portalDeliveryNote(ub.scope, o.id), null);
  assert.equal((await listPortalOrders(ub.scope, page)).total, 0);

  // ni klijent druge firme s istim partnerId-em (lažni opseg) ne dolazi do podataka
  const forged: PortalScope = { ...ua.scope, companyId: other.companyId };
  assert.equal(await portalOrder(forged, o.id), null);
  assert.equal(await portalAttachment(forged, photo.id), null);
  assert.equal(await portalDeliveryNote(forged, o.id), null);
  assert.equal((await listPortalDevices(forged, noFilters, page)).total, 0);

  // prilog drugog zapisa (npr. računa) iste firme nije dostupan ni vlasniku naloga
  const inv = await db.attachment.create({ data: { companyId: s.companyId, entity: 'item', entityId: mine.id, fileName: 'x.png', mime: 'image/png', size: 12, data: PNG() } });
  assert.equal(await portalAttachment(ua.scope, inv.id), null);

  // interna polja se ne šalju klijentu
  const shown = await portalOrder(ua.scope, o.id);
  assert.ok(shown && !('note' in shown) && !('diagnosis' in shown) && !('cost' in shown));

  // zaprimanjem nalog više nije „nova prijava"
  await transaction((tx) => changeServiceStatus(tx, s.actor, o.id, 'RECEIVED'));
  assert.equal(await portalNewCount(s.companyId), 0);

  // brisanjem pristupa nalog ostaje (bez veze na korisnika)
  await transaction((tx) => deletePortalUser(tx, s.actor, ua.id));
  assert.equal((await db.serviceOrder.findUniqueOrThrow({ where: { id: o.id } })).portalUserId, null);
});
