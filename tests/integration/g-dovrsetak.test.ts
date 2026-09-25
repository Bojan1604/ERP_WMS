/**
 * Dovršetak prijenosa — nad testnom bazom: paketi (Package), naslov predračuna,
 * zaštita TOTP koda od ponovne uporabe, „Zatim naplata prelazi u" na računu za
 * najam, uvoz specifikacija i paketa iz stare baze, „Obriši sve" s MDM podacima i
 * datotekama, prilozi vidljivi klijentu na portalu, početak automatskog izdavanja
 * i PDV po naplaćenoj naknadi na PDF-u i u eRačunu.
 */
import { storageDir } from './g-env';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { generate, generateSecret } from 'otplib';
import { cleanup, companies, setupCompany } from './f-helpers';
import { db, transaction } from '../../src/server/db';
import { addDays, fromISO, toISO, today } from '../../src/domain/dates';
import { num } from '../../src/domain/money';
import { VAT_ON_PAYMENT_NOTE } from '../../src/domain/tax';
import { deletePackage, packageItemIds, packageToDocument, savePackage } from '../../src/server/services/packages';
import { packages } from '../../src/server/queries/packages';
import { searchDevices } from '../../src/server/queries/sales';
import { saveQuote } from '../../src/server/services/quotes';
import { createDraft, issueInvoice } from '../../src/server/services/invoices';
import { openInvoiceContract } from '../../src/server/services/invoice-rent';
import { documentDefinitionFor } from '../../src/server/pdf';
import { resolveDoc } from '../../src/server/mail/draft';
import { checkSecondFactor } from '../../src/server/services/two-factor';
import { encryptSecret } from '../../src/server/fiscal/crypto';
import { deleteEverything } from '../../src/server/services/danger';
import { removeStoredFiles, wipeMdmData } from '../../src/server/mdm/wipe';
import { saveBuffer } from '../../src/server/mdm/storage';
import { addAttachments, setAttachmentPublic } from '../../src/server/services/attachments';
import { createPortalUser } from '../../src/server/portal/users';
import { reportFault } from '../../src/server/portal/report';
import { portalAttachment, portalOrder } from '../../src/server/portal/queries';
import { autoIssueCompany } from '../../src/server/jobs/auto-issue';
import { saveCompanyDocs } from '../../src/server/services/settings';
import { invoiceUbl } from '../../src/server/fiscal/ubl-source';
import { mapLegacy } from '../../src/server/import/legacy';
import { runImport } from '../../src/server/import/run';
import { attachItems } from '../../src/server/services/rentals';

before(async () => {
  await db.$connect();
});
after(async () => {
  await cleanup();
  await rm(storageDir, { recursive: true, force: true });
  await db.$disconnect();
});

const noFilters = { q: '' };
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('paketi: spremanje, izmjena, marža, ponuda / predračun / nacrt računa za kupca i brisanje', async () => {
  const s = await setupCompany({ items: 6 });
  const ids = s.items.slice(0, 3).map((i) => i.id);
  // bez uređaja i s nepostojećim uređajem — odbija
  await assert.rejects(transaction((tx) => savePackage(tx, s.actor, null, { name: 'X', itemIds: [], price: null, note: null })), /barem jedan uređaj/);
  await assert.rejects(transaction((tx) => savePackage(tx, s.actor, null, { name: ' ', itemIds: ids, price: null, note: null })), /naziv paketa/);
  const p = await transaction((tx) => savePackage(tx, s.actor, null, { name: 'Starter bistro', itemIds: ids, price: 400, note: 'napomena' }));
  assert.equal(await db.packageItem.count({ where: { packageId: p.id } }), 3);

  // pogled Paketi: nabavna 3 × 100, cijena paketa 400, marža 25 %; preporučena = nabavna / (1 − 35 %)
  let [row] = await packages(s.companyId, noFilters);
  assert.equal(row.cost, 300);
  assert.equal(row.price, 400);
  assert.equal(row.profit, 100);
  assert.equal(row.margin, 25);
  assert.equal(row.suggested, 461.55);
  assert.deepEqual(row.unavailable, []);

  // izmjena: četiri uređaja, bez vlastite cijene (zbroj preporučenih)
  await transaction((tx) => savePackage(tx, s.actor, p.id, { name: 'Starter bistro', itemIds: [...ids, s.items[3].id], price: null, note: null }));
  [row] = await packages(s.companyId, noFilters);
  assert.equal(row.devices, 4);
  assert.equal(row.price, row.suggested);
  await transaction((tx) => savePackage(tx, s.actor, p.id, { name: 'Starter bistro', itemIds: ids, price: 400, note: 'napomena' }));

  // cjenik kupca: dogovorena cijena modela 200 → raspodjela 400 razmjerno (jednako)
  await db.priceAgreement.create({ data: { companyId: s.companyId, partnerId: s.partner.id, modelId: s.model.id, salePrice: 200 } });
  const devices = await searchDevices(s.companyId, { itemIds: await packageItemIds(db, s.companyId, p.id), partnerId: s.partner.id });
  assert.ok(devices.every((d) => d.price === 200));
  const q = await transaction((tx) => packageToDocument(tx, s.actor, p.id, s.partner.id, 'PROFORMA', devices));
  const quote = await db.quote.findUniqueOrThrow({ where: { id: q.id }, include: { lines: { orderBy: { sort: 'asc' } } } });
  assert.equal(quote.kind, 'PROFORMA');
  assert.equal(num(quote.netTotal), 400);
  assert.deepEqual(quote.lines.map((l) => num(l.unitPrice)), [133.34, 133.33, 133.33]);
  assert.deepEqual(quote.lines.map((l) => l.itemId), ids);
  assert.match(quote.note ?? '', /^Paket: Starter bistro\nnapomena$/);

  const inv = await transaction((tx) => packageToDocument(tx, s.actor, p.id, s.partner.id, 'INVOICE', devices));
  const draft = await db.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { lines: true } });
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.type, 'SALE');
  assert.equal(num(draft.netTotal), 400);
  assert.equal(draft.lines.length, 3);
  assert.ok(draft.lines.every((l) => num(l.cost) === 100), 'nabavna na stavkama za maržu');

  // prodan uređaj: paket ga označava, pretvaranje i spremanje odbijaju
  await transaction((tx) => issueInvoice(tx, s.actor, inv.id));
  [row] = await packages(s.companyId, noFilters);
  assert.deepEqual(row.unavailable.sort(), ['SN0', 'SN1', 'SN2']);
  const left = await searchDevices(s.companyId, { itemIds: ids, partnerId: s.partner.id });
  await assert.rejects(transaction((tx) => packageToDocument(tx, s.actor, p.id, s.partner.id, 'QUOTE', left)), /više nisu na skladištu/);
  await assert.rejects(transaction((tx) => savePackage(tx, s.actor, p.id, { name: 'X', itemIds: ids, price: null, note: null })), /više nisu na skladištu: SN0/);

  // firma: tuđi paket se ne vidi i ne briše
  const other = await setupCompany({ items: 1 });
  await assert.rejects(transaction((tx) => deletePackage(tx, other.actor, p.id)), /Paket ne postoji/);
  await transaction((tx) => deletePackage(tx, s.actor, p.id));
  assert.equal(await db.package.count({ where: { companyId: s.companyId } }), 0);
  assert.ok(await db.auditLog.findFirst({ where: { companyId: s.companyId, entity: 'package', action: 'convert' } }));
});

test('predračun: naslov po dokumentu na PDF-u i u e-pošti; ponuda ga nema', async () => {
  const s = await setupCompany({ items: 1 });
  await db.company.update({ where: { id: s.companyId }, data: { proformaTitle: 'Profaktura' } });
  const line = { kind: 'MANUAL' as const, description: 'Usluga', qty: 1, unitPrice: 10 };
  const pf = await transaction((tx) => saveQuote(tx, s.actor, null, { kind: 'PROFORMA', title: ' Proforma račun ', partnerId: s.partner.id, date: today(), vatRate: 25, lines: [line] }));
  const qt = await transaction((tx) => saveQuote(tx, s.actor, null, { kind: 'QUOTE', title: 'Ne vrijedi', partnerId: s.partner.id, date: today(), vatRate: 25, lines: [line] }));
  assert.equal((await db.quote.findUniqueOrThrow({ where: { id: pf.id } })).title, 'Proforma račun');
  assert.equal((await db.quote.findUniqueOrThrow({ where: { id: qt.id } })).title, null);

  const def = JSON.stringify((await documentDefinitionFor('proforma', pf.id, s.companyId)).def);
  assert.ok(def.includes('Proforma račun') && !def.includes('Profaktura'));
  const user = { companyId: s.companyId, perms: {} as never };
  assert.equal((await resolveDoc(user, 'proforma', pf.id)).title, `Proforma račun ${pf.number}`);

  // prazan naslov → iz postavki firme
  await transaction((tx) => saveQuote(tx, s.actor, pf.id, { partnerId: s.partner.id, title: '', date: today(), vatRate: 25, lines: [line] }));
  assert.equal((await resolveDoc(user, 'proforma', pf.id)).title, `Profaktura ${pf.number}`);
});

test('2FA: isti TOTP kod prolazi samo jednom, i uz istodobne prijave', async () => {
  const s = await setupCompany({ items: 0 });
  const secret = generateSecret();
  await db.user.update({ where: { id: s.user.id }, data: { totpSecret: encryptSecret(secret), totpEnabled: true } });
  const code = await generate({ secret });
  const race = await Promise.all([1, 2, 3].map(() => transaction((tx) => checkSecondFactor(tx, s.user.id, code))));
  assert.equal(race.filter((r) => r === 'totp').length, 1);
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, code)), null);
  // kod prethodnog koraka (unutar tolerancije) je stariji od iskorištenog — odbija se
  const older = await generate({ secret, epoch: Math.floor(Date.now() / 1000) - 30 });
  if (older !== code) assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, older)), null);
  // sljedeći korak vrijedi
  const next = await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
  assert.equal(await transaction((tx) => checkSecondFactor(tx, s.user.id, next)), 'totp');
});

test('račun za najam: „Zatim naplata prelazi u" dodaje drugo razdoblje plana naplate uređaja', async () => {
  const s = await setupCompany({ items: 2 });
  const date = today();
  const nextFrom = `${addDays(`${date.slice(0, 7)}-01`, 40).slice(0, 7)}-01`;
  const contract = await transaction((tx) => openInvoiceContract(tx, s.actor, s.partner.id, { startDate: date, billing: 'MONTHLY', months: 24, seasonFrom: null, seasonTo: null }));
  const draft = await transaction((tx) =>
    createDraft(tx, s.actor, {
      type: 'RENT',
      partnerId: s.partner.id,
      date,
      vatRate: 25,
      contractId: contract.id,
      rentNext: { billing: 'QUARTERLY', from: nextFrom },
      lines: [{ kind: 'DEVICE', itemId: s.items[0].id, modelId: s.model.id, description: 'Najam', qty: 1, unitPrice: 20, monthly: 20, months: 1 }],
    }),
  );
  const saved = await db.invoice.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(saved.rentNextBilling, 'QUARTERLY');
  assert.equal(toISO(saved.rentNextFrom!), nextFrom);
  await transaction((tx) => issueInvoice(tx, s.actor, draft.id));
  const ci = await db.contractItem.findUniqueOrThrow({ where: { itemId: s.items[0].id } });
  assert.equal(ci.contractId, contract.id);
  assert.deepEqual(ci.plan, [
    { from: date, billing: 'MONTHLY' },
    { from: nextFrom, billing: 'QUARTERLY' },
  ]);

  // bez ugovora se prijelaz ne sprema
  const plain = await transaction((tx) =>
    createDraft(tx, s.actor, { type: 'SALE', partnerId: s.partner.id, date, vatRate: 25, rentNext: { billing: 'ANNUAL', from: nextFrom }, lines: [{ kind: 'MANUAL', description: 'x', qty: 1, unitPrice: 1 }] }),
  );
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: plain.id } })).rentNextBilling, null);
});

test('uvoz stare baze: specifikacije i kategorija po komadu u bazi, paket s uvezenim uređajima', async () => {
  const s = await setupCompany({ items: 0 });
  const raw = {
    version: 1,
    categories: [{ id: 'c1', name: 'POS' }, { id: 'c2', name: 'Vage' }],
    models: [{ id: 'm1', brand: 'Sunmi', name: 'T2', categoryId: 'c1', cpu: 'PX30', screen: '15.6"', os: 'Android 11' }],
    statuses: [{ id: 's1', name: 'Na skladištu', inStock: true, system: true }],
    warehouses: [{ id: 'w1', name: 'Zagreb' }],
    items: [
      { id: 'i1', serial: 'U1', statusId: 's1', warehouseId: 'w1', modelId: 'm1', cpu: 'RK3566' },
      { id: 'i2', serial: 'U2', statusId: 's1', warehouseId: 'w1', modelId: 'm1', categoryId: 'c2' },
    ],
    packages: [{ id: 'pk1', name: 'Starter', price: 900, itemIds: ['i1', 'i2'] }],
    settings: { companyName: 'Stara d.o.o.' },
  };
  const { plan } = mapLegacy(raw, { today: today() })!;
  const r = await runImport(plan, { target: { kind: 'new', name: `Uvoz G ${Date.now()}` }, actor: { id: s.user.id, name: s.user.name, email: s.user.email, companyId: s.companyId }, log: () => undefined });
  companies.push(r.companyId);
  const items = await db.item.findMany({ where: { companyId: r.companyId }, orderBy: { serial: 'asc' }, include: { category: true, model: true } });
  assert.deepEqual(items.map((i) => [i.serial, i.cpu, i.screen, i.os, i.category?.name ?? null]), [
    ['U1', 'RK3566', '15.6"', 'Android 11', null],
    ['U2', 'PX30', '15.6"', 'Android 11', 'Vage'],
  ]);
  assert.deepEqual([items[0].model.cpu, items[0].model.os], ['PX30', 'Android 11']);
  const pkg = await db.package.findFirstOrThrow({ where: { companyId: r.companyId }, include: { items: true } });
  assert.equal(pkg.name, 'Starter');
  assert.equal(num(pkg.price), 900);
  assert.equal(pkg.items.length, 2);
});

test('opasna zona: „Obriši sve" briše i sve MDM podatke firme (s datotekama), druga firma ostaje', async () => {
  const s = await setupCompany({ items: 2 });
  const other = await setupCompany({ items: 0 });
  async function mdmData(companyId: string) {
    const dist = await db.mdmOrg.create({ data: { companyId, type: 'DISTRIBUTOR', name: 'Distributer' } });
    const cust = await db.mdmOrg.create({ data: { companyId, type: 'CUSTOMER', name: 'Klijent', parentId: dist.id } });
    const profile = await db.mdmProfile.create({ data: { companyId, orgId: cust.id, name: 'Kasa', platform: 'ANDROID' } });
    const site = await db.mdmSite.create({ data: { orgId: cust.id, name: 'Lokacija', profileId: profile.id } });
    const device = await db.mdmDevice.create({ data: { companyId, orgId: cust.id, siteId: site.id, profileId: profile.id, platform: 'ANDROID', name: 'Kasa 1', tokenHash: `t${Math.random()}` } });
    const saved = await saveBuffer(Buffer.from('APK sadržaj'));
    const file = await db.mdmFile.create({ data: { companyId, orgId: dist.id, kind: 'APP', name: 'a.apk', mime: 'application/vnd.android.package-archive', size: saved.size, sha256: saved.sha256, storageKey: saved.key } });
    const app = await db.mdmApp.create({ data: { companyId, orgId: dist.id, platform: 'ANDROID', name: 'Kasa', packageName: `hr.kasa.${Math.random()}` } });
    await db.mdmAppVersion.create({ data: { appId: app.id, version: '1.0', fileId: file.id } });
    const shot = await saveBuffer(Buffer.from('PNG snimka'));
    const shotFile = await db.mdmFile.create({ data: { companyId, kind: 'SCREENSHOT', name: 's.png', mime: 'image/png', size: shot.size, sha256: shot.sha256, storageKey: shot.key } });
    await db.mdmUpload.create({ data: { deviceId: device.id, kind: 'SCREENSHOT', fileId: shotFile.id } });
    await db.mdmCommand.create({ data: { deviceId: device.id, type: 'REBOOT' } });
    await db.mdmEvent.create({ data: { deviceId: device.id, type: 'ONLINE', message: 'online' } });
    await db.mdmEnrollToken.create({ data: { companyId, orgId: cust.id, siteId: site.id, token: `e${Math.random()}` } });
    // uređaj povezan s uređajem skladišta
    if (s.items[0] && companyId === s.companyId) await db.mdmDevice.update({ where: { id: device.id }, data: { itemId: s.items[0].id } });
    const ext = await db.user.create({ data: { companyId, email: `mdm${Math.random()}@t.hr`, name: 'Vanjski', passwordHash: 'x', role: 'CLIENT', mdmOrgId: cust.id } });
    return { keys: [saved.key, shot.key], ext };
  }
  const mine = await mdmData(s.companyId);
  const theirs = await mdmData(other.companyId);
  const res = await db.$transaction((tx) => deleteEverything(tx, s.actor), { timeout: 60_000 });
  assert.deepEqual(res.mdmFiles.sort(), mine.keys.sort());
  const c = s.companyId;
  const left = await Promise.all([
    db.mdmOrg.count({ where: { companyId: c } }), db.mdmSite.count({ where: { org: { companyId: c } } }), db.mdmDevice.count({ where: { companyId: c } }),
    db.mdmProfile.count({ where: { companyId: c } }), db.mdmApp.count({ where: { companyId: c } }), db.mdmFile.count({ where: { companyId: c } }),
    db.mdmEnrollToken.count({ where: { companyId: c } }), db.mdmCommand.count({ where: { device: { companyId: c } } }),
    db.mdmEvent.count({ where: { device: { companyId: c } } }), db.mdmUpload.count({ where: { device: { companyId: c } } }),
  ]);
  assert.deepEqual(left, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(await db.user.findUnique({ where: { id: mine.ext.id } }), null, 'vanjski korisnik MDM-a obrisan');
  assert.ok(await db.user.findUnique({ where: { id: s.user.id } }));
  // datoteke s diska tek nakon potvrde transakcije
  for (const k of mine.keys) await stat(path.join(storageDir, k));
  assert.equal(await removeStoredFiles(res.mdmFiles), 2);
  for (const k of mine.keys) await assert.rejects(stat(path.join(storageDir, k)));
  // druga firma netaknuta
  assert.equal(await db.mdmDevice.count({ where: { companyId: other.companyId } }), 1);
  assert.equal(await db.mdmFile.count({ where: { companyId: other.companyId } }), 2);
  for (const k of theirs.keys) await stat(path.join(storageDir, k));
  // počisti drugu firmu (MDM ima ograničenja koja kaskadno brisanje ne prolazi)
  const w = await transaction((tx) => wipeMdmData(tx, other.companyId));
  await removeStoredFiles(w.storageKeys);
});

test('portal: klijent vidi samo priloge označene „vidljivo klijentu"', async () => {
  const s = await setupCompany({ items: 1 });
  const sold = await db.itemStatus.findFirstOrThrow({ where: { companyId: s.companyId, kind: 'SOLD' } });
  await db.item.update({ where: { id: s.items[0].id }, data: { state: 'SOLD', statusId: sold.id, partnerId: s.partner.id, warehouseId: null, issueDate: fromISO(today()) } });
  const pu = await transaction((tx) => createPortalUser(tx, s.actor, { partnerId: s.partner.id, name: 'Klijent', email: `g${Date.now()}${Math.random()}@k.hr` }));
  const scope = { id: pu.id, companyId: s.companyId, partnerId: s.partner.id, name: 'Klijent', email: pu.email };
  const order = await transaction((tx) => reportFault(tx, scope, { itemId: s.items[0].id, issue: 'Ne radi', contact: null }, [{ fileName: 'kvar.png', data: PNG() }]));
  const [photo] = await db.attachment.findMany({ where: { entity: 'serviceOrder', entityId: order.id } });
  assert.equal(photo.public, true, 'fotografija s portala je vidljiva klijentu');
  // interni prilog servisa
  const [internal] = await transaction((tx) => addAttachments(tx, s.actor, 'serviceOrder', order.id, [{ fileName: 'dijagnoza.png', data: PNG() }]));
  assert.equal(internal.public, false);

  let o = await portalOrder(scope, order.id);
  assert.deepEqual(o?.photos.map((p) => p.id), [photo.id]);
  assert.equal(await portalAttachment(scope, internal.id), null, 'interni prilog se ne može preuzeti s portala');
  assert.ok(await portalAttachment(scope, photo.id));

  // osoblje ga podijeli s klijentom, pa opet skrije
  await transaction((tx) => setAttachmentPublic(tx, s.actor, internal.id, true));
  o = await portalOrder(scope, order.id);
  assert.equal(o?.photos.length, 2);
  assert.ok(await portalAttachment(scope, internal.id));
  await transaction((tx) => setAttachmentPublic(tx, s.actor, internal.id, false));
  assert.equal(await portalAttachment(scope, internal.id), null);
  // samo prilozi servisnog naloga
  const inv = await transaction((tx) => createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: today(), vatRate: 25, lines: [{ kind: 'MANUAL', description: 'x', qty: 1, unitPrice: 1 }] }));
  const [invAtt] = await transaction((tx) => addAttachments(tx, s.actor, 'invoice', inv.id, [{ fileName: 'r.png', data: PNG() }], { public: true }));
  assert.equal(invAtt.public, false);
  await assert.rejects(transaction((tx) => setAttachmentPublic(tx, s.actor, invAtt.id, true)), /samo prilozi servisnog naloga/);
});

test('automatsko izdavanje: samo rate od dana uključivanja (bez zaostataka), datum upisuje spremanje postavki', async () => {
  const s = await setupCompany({ items: 1 });
  const start = `${addDays(`${today().slice(0, 7)}-01`, -45).slice(0, 7)}-01`;
  const contract = await db.contract.create({ data: { companyId: s.companyId, number: `UG-G-${Math.random()}`, partnerId: s.partner.id, startDate: fromISO(start), billing: 'MONTHLY' } });
  await transaction((tx) => attachItems(tx, s.actor, contract.id, [{ itemId: s.items[0].id, monthly: 20 }], { issueDate: start }));

  // uključivanje u postavkama upisuje današnji dan; isključivanje ga briše
  const c = await db.company.findUniqueOrThrow({ where: { id: s.companyId } });
  const docs = {
    swift: null, proformaTitle: c.proformaTitle, eInvoicePaymentMeans: c.eInvoicePaymentMeans, paymentModel: c.paymentModel, operatorName: null, operatorOib: null,
    vatTextEuGoods: null, vatTextEuService: null, vatTextThirdGoods: null, vatTextThirdService: null, legalFooter: null, vatOnPayment: false,
    kpdRent: null, kpdSale: null, kpdService: null, eInvoiceAttachPdf: true, eReportingEnabled: true,
  };
  await transaction((tx) => saveCompanyDocs(tx, s.actor, { ...docs, autoIssueRent: true }));
  assert.equal(toISO((await db.company.findUniqueOrThrow({ where: { id: s.companyId } })).autoIssueSince!), today());
  await transaction((tx) => saveCompanyDocs(tx, s.actor, { ...docs, autoIssueRent: false }));
  assert.equal((await db.company.findUniqueOrThrow({ where: { id: s.companyId } })).autoIssueSince, null);

  // od početka tekućeg mjeseca: izdaje se samo tekuća rata, dvije ranije ostaju za ručno izdavanje
  await db.company.update({ where: { id: s.companyId }, data: { autoIssueRent: true, autoIssueSince: fromISO(`${today().slice(0, 7)}-01`) } });
  const r = await autoIssueCompany(s.companyId, { fiscalize: false });
  assert.equal(r.issued.length, 1);
  const inv = await db.invoice.findFirstOrThrow({ where: { companyId: s.companyId, type: 'RENT', status: 'ISSUED' } });
  assert.equal(inv.period, today().slice(0, 7));
});

test('PDV po naplaćenoj naknadi: napomena na PDF-u i oznaka u eRačunu', async () => {
  const s = await setupCompany({ items: 0 });
  await db.company.update({ where: { id: s.companyId }, data: { vatOnPayment: true, oib: '12345678903' } });
  await db.partner.update({ where: { id: s.partner.id }, data: { oib: '69435151530' } });
  const d = await transaction((tx) => createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: today(), vatRate: 25, lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 100 }] }));
  await transaction((tx) => issueInvoice(tx, s.actor, d.id));
  const def = JSON.stringify((await documentDefinitionFor('invoice', d.id, s.companyId)).def);
  assert.ok(def.includes(VAT_ON_PAYMENT_NOTE));
  const u = await invoiceUbl(s.companyId, d.id);
  assert.match(u?.xml ?? '', /<hrextac:HRObracunPDVPoNaplati>Obračun po naplaćenoj naknadi<\/hrextac:HRObracunPDVPoNaplati>/);
  assert.ok((u?.xml ?? '').includes(`<cbc:Note>${VAT_ON_PAYMENT_NOTE}</cbc:Note>`));
});
