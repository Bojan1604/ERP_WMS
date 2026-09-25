/**
 * Područje F — podaci firme: opasna zona (brisanje prometa / svega), sigurnosna
 * kopija i vraćanje (uključujući nove tablice), nastavak numeracije i provjera dosljednosti.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { db, transaction } from '../../src/server/db';
import { createDraft, issueInvoice, addPayment } from '../../src/server/services/invoices';
import { attachItems } from '../../src/server/services/rentals';
import { confirmDanger, deleteEverything, deleteTransactions } from '../../src/server/services/danger';
import { setCounterStart } from '../../src/server/services/settings';
import { fixIntegrity, integrityCheck, resetDefaultStatuses, cleanAuditLog, databaseStats } from '../../src/server/services/maintenance';
import { createBackup, listBackups, readBackup, pruneBackups, runAutoBackups } from '../../src/server/jobs/backups';
import { planFromJson } from '../../src/server/import/analyze';
import { runImport } from '../../src/server/import/run';
import { fromISO, today } from '../../src/domain/dates';
import { cleanup, companies, setupCompany } from './f-helpers';

let backupDir = '';
before(async () => {
  await db.$connect();
  backupDir = await mkdtemp(path.join(tmpdir(), 'f-kopije-'));
  process.env.BACKUP_DIR = backupDir;
});
after(async () => {
  await cleanup();
  await rm(backupDir, { recursive: true, force: true });
  await db.$disconnect();
});

const YEAR = Number(today().slice(0, 4));

/** Firma s prometom u svim tablicama koje „Obriši promet" briše. */
async function richCompany() {
  const s = await setupCompany({ items: 8 });
  const c = s.companyId;
  await db.user.update({ where: { id: s.user.id }, data: { passwordHash: await bcrypt.hash('tajna1234', 4) } });
  // prodaja s uplatom
  const sale = await transaction((tx) =>
    createDraft(tx, s.actor, { type: 'SALE', partnerId: s.partner.id, date: `${YEAR}-02-01`, vatRate: 25, lines: [{ kind: 'DEVICE', itemId: s.items[0].id, modelId: s.model.id, description: 'X', qty: 1, unitPrice: 200 }] }),
  );
  await transaction((tx) => issueInvoice(tx, s.actor, sale.id));
  await transaction((tx) => addPayment(tx, s.actor, sale.id, { date: `${YEAR}-02-05`, amount: 100 }));
  // najam
  const contract = await db.contract.create({ data: { companyId: c, number: `UG-${Math.random()}`, partnerId: s.partner.id, startDate: fromISO(`${YEAR}-01-01`) } });
  await transaction((tx) => attachItems(tx, s.actor, contract.id, [{ itemId: s.items[1].id, monthly: 20 }], { issueDate: `${YEAR}-01-01` }));
  await db.rentOverride.create({ data: { companyId: c, itemId: s.items[1].id, year: YEAR, month: 1, amount: 15 } });
  // ponuda, servis, nabava, troškovi, međuskladišnica, inventura, odobrenje, prilog, e-pošta, fiskalni trag
  const quote = await db.quote.create({ data: { companyId: c, number: 'PON-1', date: fromISO(`${YEAR}-01-10`), partnerId: s.partner.id, vatRate: 25, lines: { create: [{ kind: 'MANUAL', description: 'x', qty: 1, unitPrice: 5 }] } } });
  await db.serviceOrder.create({ data: { companyId: c, number: 'RMA-1', reportedAt: fromISO(`${YEAR}-01-12`), issue: 'Ne radi', itemId: s.items[2].id, partnerId: s.partner.id } });
  const po = await db.purchaseOrder.create({ data: { companyId: c, number: 'NAR-1', supplierId: s.supplier.id, date: fromISO(`${YEAR}-01-02`), lines: { create: [{ modelId: s.model.id, qty: 2 }] } } });
  const rec = await db.goodsReceipt.create({ data: { companyId: c, number: 'PRI-1', date: fromISO(`${YEAR}-01-03`), warehouseId: s.wh.id, orderId: po.id, supplierId: s.supplier.id } });
  await db.item.update({ where: { id: s.items[3].id }, data: { receiptId: rec.id } });
  const si = await db.supplierInvoice.create({ data: { companyId: c, internalNo: 'URA-1', number: '77', supplierId: s.supplier.id, issueDate: fromISO(`${YEAR}-01-04`), orderId: po.id, receiptId: rec.id } });
  await db.expense.create({ data: { companyId: c, date: fromISO(`${YEAR}-01-04`), description: 'Nabava', netAmount: 100, receiptId: rec.id, supplierInvoiceId: si.id } });
  await db.transfer.create({ data: { companyId: c, number: 'MSK-1', date: fromISO(`${YEAR}-01-05`), toWarehouseId: s.wh.id, items: { create: [{ itemId: s.items[4].id }] } } });
  await db.stocktake.create({ data: { companyId: c, number: 'INV-1', scans: { create: [{ serial: 'SN4' }] } } });
  await db.approvalRequest.create({ data: { companyId: c, kind: 'STATUS_CHANGE', payload: {}, requestedBy: 'Ana' } });
  await db.attachment.create({ data: { companyId: c, entity: 'invoice', entityId: sale.id, fileName: 'a.pdf', mime: 'application/pdf', size: 4, data: Buffer.from('%PDF') } });
  await db.emailLog.create({ data: { companyId: c, kind: 'invoice', entityId: sale.id, to: 'k@k.hr', subject: 'Račun', status: 'SENT' } });
  await db.emailLog.create({ data: { companyId: c, kind: 'quote', entityId: quote.id, to: 'k@k.hr', subject: 'Ponuda', status: 'FAILED', error: 'x' } });
  await db.fiscalLog.create({ data: { companyId: c, kind: 'FISCAL', ok: true } });
  await db.priceAgreement.create({ data: { companyId: c, partnerId: s.partner.id, modelId: s.model.id, salePrice: 180 } });
  await db.package.create({ data: { companyId: c, name: 'Paket', items: { create: [{ itemId: s.items[5].id }] } } });
  const portal = await db.portalUser.create({ data: { companyId: c, partnerId: s.partner.id, email: `p${Math.random()}@k.hr`, passwordHash: await bcrypt.hash('portal123', 4) } });
  return { ...s, sale, contract, quote, portal };
}

const counts = (c: string) =>
  Promise.all([
    db.item.count({ where: { companyId: c } }), db.invoice.count({ where: { companyId: c } }), db.contract.count({ where: { companyId: c } }),
    db.quote.count({ where: { companyId: c } }), db.serviceOrder.count({ where: { companyId: c } }), db.expense.count({ where: { companyId: c } }),
    db.supplierInvoice.count({ where: { companyId: c } }), db.purchaseOrder.count({ where: { companyId: c } }), db.goodsReceipt.count({ where: { companyId: c } }),
    db.transfer.count({ where: { companyId: c } }), db.stocktake.count({ where: { companyId: c } }), db.attachment.count({ where: { companyId: c } }),
    db.emailLog.count({ where: { companyId: c } }), db.itemEvent.count({ where: { companyId: c } }), db.documentCounter.count({ where: { companyId: c } }),
    db.approvalRequest.count({ where: { companyId: c } }), db.fiscalLog.count({ where: { companyId: c } }), db.rentOverride.count({ where: { companyId: c } }),
    db.package.count({ where: { companyId: c } }),
  ]);

test('opasna zona: potvrda traži pravo, lozinku i točan naziv firme', async () => {
  const s = await richCompany();
  const actor = { ...s.actor, role: 'ADMIN' as const, canDanger: true };
  await assert.rejects(transaction((tx) => confirmDanger(tx, actor, { password: 'kriva', companyName: s.company.name })), /Lozinka nije ispravna/);
  await assert.rejects(transaction((tx) => confirmDanger(tx, actor, { password: 'tajna1234', companyName: 'Druga' })), /točan naziv firme/);
  const sales = await db.user.create({ data: { companyId: s.companyId, email: `s${Math.random()}@t.hr`, name: 'Prodaja', passwordHash: await bcrypt.hash('x12345678', 4), role: 'SALES' } });
  await assert.rejects(
    transaction((tx) => confirmDanger(tx, { id: sales.id, name: 'Prodaja', companyId: s.companyId, role: 'SALES', canDanger: false }, { password: 'x12345678', companyName: s.company.name })),
    /opasnu zonu/,
  );
  // pravo uz User.canDanger
  await db.user.update({ where: { id: sales.id }, data: { canDanger: true } });
  await transaction((tx) => confirmDanger(tx, { id: sales.id, name: 'Prodaja', companyId: s.companyId, role: 'SALES', canDanger: true }, { password: 'x12345678', companyName: s.company.name }));
});

test('opasna zona: „Obriši promet" briše sav promet u jednoj transakciji, a partneri, šifrarnici, korisnici i druga firma ostaju', async () => {
  const s = await richCompany();
  const other = await richCompany();
  const before = await counts(other.companyId);
  assert.ok((await counts(s.companyId)).every((n) => n > 0), 'priprema: svaka tablica prometa ima zapis');

  const deleted = await db.$transaction((tx) => deleteTransactions(tx, s.actor), { timeout: 60_000 });
  assert.equal(deleted.Item, 8);
  assert.deepEqual(await counts(s.companyId), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // ostaje: partneri, dogovorene cijene, modeli, kategorije, statusi, skladišta, korisnici, portal, postavke
  const c = s.companyId;
  assert.equal(await db.partner.count({ where: { companyId: c } }), 2);
  assert.equal(await db.priceAgreement.count({ where: { companyId: c } }), 1);
  assert.equal(await db.deviceModel.count({ where: { companyId: c } }), 1);
  assert.equal(await db.category.count({ where: { companyId: c } }), 1);
  assert.ok((await db.itemStatus.count({ where: { companyId: c } })) >= 7);
  assert.ok(await db.warehouse.count({ where: { companyId: c } }));
  assert.equal(await db.user.count({ where: { companyId: c } }), 1);
  assert.equal(await db.portalUser.count({ where: { companyId: c } }), 1);
  // u dnevniku ostaje samo zapis o brisanju
  const logs = await db.auditLog.findMany({ where: { companyId: c } });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'wipe-transactions');
  // druga firma netaknuta
  assert.deepEqual(await counts(other.companyId), before);
  // numeracija kreće ispočetka
  const d = await transaction((tx) => createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: `${YEAR}-03-01`, vatRate: 25, lines: [{ kind: 'MANUAL', description: 'x', qty: 1, unitPrice: 1 }] }));
  assert.equal((await transaction((tx) => issueInvoice(tx, s.actor, d.id))).number, '1/T1/1');
});

test('opasna zona: „Obriši sve" ostavlja firmu, vlastiti račun i sistemske statuse', async () => {
  const s = await richCompany();
  const other = await db.user.create({ data: { companyId: s.companyId, email: `o${Math.random()}@t.hr`, name: 'Drugi', passwordHash: 'x', role: 'SALES' } });
  await db.$transaction((tx) => deleteEverything(tx, s.actor), { timeout: 60_000 });
  const c = s.companyId;
  assert.equal(await db.partner.count({ where: { companyId: c } }), 0);
  assert.equal(await db.deviceModel.count({ where: { companyId: c } }), 0);
  assert.equal(await db.portalUser.count({ where: { companyId: c } }), 0);
  assert.equal(await db.user.findUnique({ where: { id: other.id } }), null);
  assert.ok(await db.user.findUnique({ where: { id: s.user.id } }));
  assert.equal(await db.itemStatus.count({ where: { companyId: c, system: true } }), 7);
  assert.equal(await db.warehouse.count({ where: { companyId: c } }), 1);
  assert.ok(await db.company.findUnique({ where: { id: c } }));
});

test('sigurnosna kopija: spremanje, popis, zadržavanje i vraćanje u novu firmu s novim tablicama', async () => {
  const s = await richCompany();
  await db.company.update({ where: { id: s.companyId }, data: { swift: 'PBZGHR2X', proformaTitle: 'Proforma', autoIssueRent: true, vatTextEuGoods: 'Vlastiti EU tekst' } });
  const b = await createBackup(s.companyId, 'rucna');
  assert.match(b.name, /^kopija-\d{4}-\d{2}-\d{2}-\d{6}-rucna\.json\.gz$/);
  assert.ok((await db.company.findUniqueOrThrow({ where: { id: s.companyId } })).lastBackupAt);
  const list = await listBackups(s.companyId);
  assert.equal(list.length, 1);

  const raw = (await readBackup(s.companyId, b.name)) as Record<string, unknown[]>;
  assert.equal((raw.emailLogs as unknown[]).length, 2);
  assert.equal((raw.portalUsers as unknown[]).length, 1);
  assert.ok(!JSON.stringify(raw.users).includes('passwordHash'), 'lozinke korisnika nisu u kopiji');

  // izvorni korisnik portala još postoji → e-adresa zauzeta, preskače se; nakon brisanja izvora se vraća
  const { plan } = planFromJson(raw);
  const actor = { id: s.user.id, name: s.user.name, email: s.user.email, companyId: s.companyId };
  const r1 = await runImport(plan, { target: { kind: 'new', name: `Vraćena ${Math.random()}` }, actor, log: () => undefined });
  companies.push(r1.companyId);
  const nc = r1.companyId;
  assert.equal(await db.item.count({ where: { companyId: nc } }), 8);
  assert.equal(await db.invoice.count({ where: { companyId: nc } }), await db.invoice.count({ where: { companyId: s.companyId } }));
  assert.equal(await db.emailLog.count({ where: { companyId: nc } }), 2);
  const mail = await db.emailLog.findFirstOrThrow({ where: { companyId: nc, kind: 'invoice' } });
  const inv = await db.invoice.findFirstOrThrow({ where: { companyId: nc, type: 'SALE' } });
  assert.equal(mail.entityId, inv.id, 'e-pošta pokazuje na vraćeni račun');
  assert.equal(await db.portalUser.count({ where: { companyId: nc } }), 0);
  assert.equal(r1.skipped.portalUsers, 1);
  // postavke F9 su vraćene, automatsko izdavanje nije
  const restored = await db.company.findUniqueOrThrow({ where: { id: nc } });
  assert.equal(restored.swift, 'PBZGHR2X');
  assert.equal(restored.proformaTitle, 'Proforma');
  assert.equal(restored.vatTextEuGoods, 'Vlastiti EU tekst');
  assert.equal(restored.autoIssueRent, false);
  // tko vraća, dobiva pristup novoj firmi
  assert.ok(await db.userCompany.findUnique({ where: { userId_companyId: { userId: s.user.id, companyId: nc } } }));

  await db.portalUser.delete({ where: { id: s.portal.id } });
  const r2 = await runImport(planFromJson(raw).plan, { target: { kind: 'new', name: `Vraćena 2 ${Math.random()}` }, actor, log: () => undefined });
  companies.push(r2.companyId);
  const pu = await db.portalUser.findFirstOrThrow({ where: { companyId: r2.companyId } });
  assert.ok(await bcrypt.compare('portal123', pu.passwordHash), 'klijent se prijavljuje istom lozinkom');
  const partner = await db.partner.findUniqueOrThrow({ where: { id: pu.partnerId } });
  assert.equal(partner.companyId, r2.companyId);

  // zadržavanje: automatske preko granice se brišu, ručne ostaju
  await db.company.update({ where: { id: s.companyId }, data: { backupKeep: 1 } });
  await createBackup(s.companyId, 'auto');
  await createBackup(s.companyId, 'auto');
  await pruneBackups(s.companyId, 1);
  const after2 = await listBackups(s.companyId);
  assert.equal(after2.filter((x) => x.kind === 'auto').length, 1);
  assert.equal(after2.filter((x) => x.kind === 'rucna').length, 1);
});

test('automatska kopija: jednom dnevno i kad je pokrenu dva procesa istodobno', async () => {
  const s = await setupCompany({ items: 1 });
  await db.company.update({ where: { id: s.companyId }, data: { autoBackup: true, lastBackupAt: null } });
  const [a, b] = await Promise.all([runAutoBackups(), runAutoBackups()]);
  const mine = [...a, ...b].filter((x) => x.companyId === s.companyId);
  assert.equal(mine.length, 1);
  assert.ok(mine[0].ok);
  assert.equal((await runAutoBackups()).filter((x) => x.companyId === s.companyId).length, 0);
  assert.equal((await listBackups(s.companyId)).length, 1);
});

test('nastavak numeracije: sljedeći broj, ne ispod izdanih', async () => {
  const s = await setupCompany({ items: 0 });
  const issue = async (date: string) => {
    const d = await transaction((tx) => createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date, vatRate: 25, lines: [{ kind: 'MANUAL', description: 'x', qty: 1, unitPrice: 1 }] }));
    return (await transaction((tx) => issueInvoice(tx, s.actor, d.id))).number;
  };
  await transaction((tx) => setCounterStart(tx, s.actor, 'INVOICE', YEAR, 120));
  assert.equal(await issue(`${YEAR}-01-10`), '120/T1/1');
  await assert.rejects(transaction((tx) => setCounterStart(tx, s.actor, 'INVOICE', YEAR, 100)), /ne može biti manji od 121/);
  await assert.rejects(transaction((tx) => setCounterStart(tx, s.actor, 'INVOICE', YEAR, 120)), /121/);
  await transaction((tx) => setCounterStart(tx, s.actor, 'INVOICE', YEAR, 200));
  assert.equal(await issue(`${YEAR}-01-11`), '200/T1/1');
  // brojač iza izdanih (npr. nakon uvoza) — izdani broj je donja granica
  await db.documentCounter.update({ where: { companyId_series_year: { companyId: s.companyId, series: 'INVOICE', year: YEAR } }, data: { last: 5 } });
  await assert.rejects(transaction((tx) => setCounterStart(tx, s.actor, 'INVOICE', YEAR, 150)), /201/);
  // provjera dosljednosti to vidi i sigurno popravlja
  const f = await integrityCheck(s.companyId);
  assert.ok(f.some((x) => x.code === 'counter-behind' && x.fixable));
  await transaction((tx) => fixIntegrity(tx, s.actor));
  assert.equal(await issue(`${YEAR}-01-12`), '201/T1/1');
  // druga serija
  await transaction((tx) => setCounterStart(tx, s.actor, 'QUOTE', YEAR, 50));
  const q = await db.documentCounter.findUniqueOrThrow({ where: { companyId_series_year: { companyId: s.companyId, series: 'QUOTE', year: YEAR } } });
  assert.equal(q.last, 49);
  assert.ok(await db.auditLog.findFirst({ where: { companyId: s.companyId, action: 'counter' } }));
});

test('održavanje: provjera dosljednosti, zadani statusi, čišćenje dnevnika, stanje baze', async () => {
  const s = await setupCompany({ items: 3 });
  const c = s.companyId;
  // uređaj na skladištu vezan uz partnera + pogrešna preslika statusa + uređaj u najmu bez ugovora
  await db.item.update({ where: { id: s.items[0].id }, data: { partnerId: s.partner.id } });
  const rented = await db.itemStatus.findFirstOrThrow({ where: { companyId: c, kind: 'RENTED' } });
  await db.item.update({ where: { id: s.items[1].id }, data: { statusId: rented.id, state: 'RENTED' } });
  await db.item.update({ where: { id: s.items[2].id }, data: { state: 'SOLD' } });
  const found = await integrityCheck(c);
  const codes = found.map((f) => f.code);
  assert.ok(codes.includes('stock-with-partner'));
  assert.ok(codes.includes('rented-no-contract'));
  assert.ok(codes.includes('state-mismatch'));
  await transaction((tx) => fixIntegrity(tx, s.actor));
  const after2 = (await integrityCheck(c)).map((f) => f.code);
  assert.ok(!after2.includes('stock-with-partner') && !after2.includes('state-mismatch'));
  assert.ok(after2.includes('rented-no-contract'), 'ručni nalaz ostaje');
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: s.items[2].id } })).state, 'IN_STOCK');

  // zadani statusi: preimenovani sistemski se vraća, obrisani dodatni se stvara
  const stock = await db.itemStatus.findFirstOrThrow({ where: { companyId: c, kind: 'IN_STOCK', system: true } });
  await db.itemStatus.update({ where: { id: stock.id }, data: { name: 'Lager', color: 'red' } });
  await db.itemStatus.deleteMany({ where: { companyId: c, name: 'Demo' } });
  const r = await transaction((tx) => resetDefaultStatuses(tx, s.actor));
  assert.equal(r.created, 1);
  assert.equal((await db.itemStatus.findUniqueOrThrow({ where: { id: stock.id } })).name, 'Na skladištu');

  await db.auditLog.create({ data: { companyId: c, entity: 'x', action: 'x', summary: 'stari', at: new Date(Date.now() - 400 * 86_400_000) } });
  const n = await transaction((tx) => cleanAuditLog(tx, s.actor, 365));
  assert.equal(n, 1);
  const stats = await databaseStats(c);
  assert.equal(stats.rows.find((x) => x[0] === 'Uređaji')?.[1], 3);
});
