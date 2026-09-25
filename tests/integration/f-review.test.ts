/**
 * Područje F — ispravci iz pregleda koda: demo firma (brisanje samo nje, korisnici
 * s drugom firmom ostaju), „Obriši sve" bez administratorskih prava ne briše
 * administratore, odobrenja statusa postavlja samo administrator, nadzorna ploča
 * bez nabavnih cijena, izvještaji po stavkama nakon popusta i s odobrenjima,
 * ograničenje pokušaja prijave u bazi, granica veličine kopije za vraćanje.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { db, transaction } from '../../src/server/db';
import { deleteEverything, removeDemoCompany } from '../../src/server/services/danger';
import { saveUser } from '../../src/server/services/users';
import { dashboardData } from '../../src/server/queries/dashboard';
import { createDraft, creditNote, issueInvoice, stornoInvoice } from '../../src/server/services/invoices';
import { attachItems } from '../../src/server/services/rentals';
import { findReport, readFilters, runReport } from '../../src/server/queries/reports';
import { beginAttempt, cleanupLoginAttempts, loginKeys, succeedAttempt } from '../../src/server/services/login-attempts';
import { readBackup } from '../../src/server/jobs/backups';
import { resolvePermissions } from '../../src/domain/permissions';
import { fromISO, today } from '../../src/domain/dates';
import { cleanup, companies, setupCompany } from './f-helpers';

before(async () => {
  await db.$connect();
});
after(async () => {
  await cleanup();
  await db.$disconnect();
});

const uniq = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

test('demo: briše se samo demo firma; korisnik s drugom firmom se vraća u nju, ostali se brišu', async () => {
  const home = await setupCompany({ items: 0, name: 'Demo Oprema d.o.o.' }); // stvarna firma istog naziva
  const demo = await setupCompany({ items: 2 });
  await db.company.update({ where: { id: demo.companyId }, data: { isDemo: true } });
  // administrator stvarne firme je prešao u demo firmu
  await db.userCompany.createMany({ data: [{ userId: home.user.id, companyId: home.companyId }, { userId: home.user.id, companyId: demo.companyId }] });
  await db.user.update({ where: { id: home.user.id }, data: { companyId: demo.companyId } });

  await assert.rejects(transaction((tx) => removeDemoCompany(tx, home.companyId)), /samo demo firma/);
  const r = await transaction((tx) => removeDemoCompany(tx, demo.companyId));
  assert.equal(r.removedUsers, 1, 'briše se samo demo korisnik bez druge firme');
  assert.equal(await db.company.count({ where: { id: demo.companyId } }), 0);
  assert.equal(await db.company.count({ where: { id: home.companyId } }), 1, 'firma istog naziva bez oznake demo ostaje');
  const admin = await db.user.findUniqueOrThrow({ where: { id: home.user.id } });
  assert.equal(admin.companyId, home.companyId, 'administrator se vraća u svoju firmu');
  assert.equal(await db.user.count({ where: { id: demo.user.id } }), 0);
});

test('„Obriši sve" korisnika s pravom opasne zone (ne administratora) ne briše administratore', async () => {
  const s = await setupCompany({ items: 1 });
  const mgr = await db.user.create({ data: { companyId: s.companyId, email: `m${uniq()}@t.hr`, name: 'Voditelj', passwordHash: 'x', role: 'MANAGER', canDanger: true } });
  const sales = await db.user.create({ data: { companyId: s.companyId, email: `s${uniq()}@t.hr`, name: 'Prodaja', passwordHash: 'x', role: 'SALES' } });
  await db.userCompany.createMany({ data: [{ userId: s.user.id, companyId: s.companyId }, { userId: sales.id, companyId: s.companyId }] });
  await db.$transaction((tx) => deleteEverything(tx, { id: mgr.id, name: mgr.name, companyId: s.companyId }), { timeout: 60_000 });
  const admin = await db.user.findUnique({ where: { id: s.user.id } });
  assert.ok(admin, 'administrator ostaje');
  assert.equal(admin.companyId, s.companyId);
  assert.equal(await db.userCompany.count({ where: { userId: s.user.id, companyId: s.companyId } }), 1, 'administrator zadržava pristup');
  assert.equal(await db.user.count({ where: { id: sales.id } }), 0, 'ostali korisnici se brišu');
});

test('odobrenja statusa (requireApproval) postavlja samo administrator', async () => {
  const s = await setupCompany({ items: 0 });
  const mgr = await db.user.create({ data: { companyId: s.companyId, email: `m${uniq()}@t.hr`, name: 'Voditelj', passwordHash: 'x', role: 'MANAGER' } });
  const actor = { id: mgr.id, name: mgr.name, companyId: s.companyId };
  const base = { name: 'Skladištar', role: 'WAREHOUSE' as const, active: true, password: 'lozinka123', permissions: {} };
  const id = await transaction((tx) => saveUser(tx, actor, null, { ...base, email: `w${uniq()}@t.hr`, requireApproval: false }));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id } })).requireApproval, null, 'ne-administrator ne može isključiti odobrenje');
  const u = await db.user.findUniqueOrThrow({ where: { id } });
  await transaction((tx) => saveUser(tx, actor, id, { ...base, email: u.email, password: null, requireApproval: false }));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id } })).requireApproval, null);
  // administrator smije
  await transaction((tx) => saveUser(tx, s.actor, id, { ...base, email: u.email, password: null, requireApproval: false }));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id } })).requireApproval, false);
});

test('nadzorna ploča: vrijednost zalihe samo uz pravo na nabavne cijene; dobit = sav prihod − nabavna prodanog', async () => {
  const s = await setupCompany({ items: 4 });
  const year = Number(today().slice(0, 4));
  const d = await transaction((tx) =>
    createDraft(tx, s.actor, {
      type: 'SALE', partnerId: s.partner.id, date: `${year}-01-10`, vatRate: 25,
      lines: [{ kind: 'DEVICE', itemId: s.items[0].id, modelId: s.model.id, description: 'Sunmi T2s', qty: 1, unitPrice: 300 }],
    }),
  );
  await transaction((tx) => issueInvoice(tx, s.actor, d.id));
  const contract = await db.contract.create({ data: { companyId: s.companyId, number: `UG-${uniq()}`, partnerId: s.partner.id, startDate: fromISO(`${year}-01-01`), billing: 'MONTHLY' } });
  await transaction((tx) => attachItems(tx, s.actor, contract.id, [{ itemId: s.items[1].id, monthly: 40 }], { issueDate: `${year}-01-01` }));
  // usluga: prihod bez nabavne — ulazi u bruto dobit
  const svc = await transaction((tx) =>
    createDraft(tx, s.actor, { type: 'SERVICE', partnerId: s.partner.id, date: `${year}-01-15`, vatRate: 25, lines: [{ kind: 'MANUAL', description: 'Servis', qty: 1, unitPrice: 40 }] }),
  );
  await transaction((tx) => issueInvoice(tx, s.actor, svc.id));

  const wh = await dashboardData(s.companyId, resolvePermissions('WAREHOUSE', {}));
  assert.ok(wh.kpi.stock);
  assert.equal(wh.kpi.stock.value, null, 'skladištar ne vidi nabavnu vrijednost zalihe');
  const admin = await dashboardData(s.companyId, resolvePermissions('ADMIN', {}));
  assert.equal(admin.kpi.stock?.value, 200);
  const jan = admin.months![0];
  assert.equal(jan.SERVICE, 40);
  assert.equal(jan.profit, jan.SALE + jan.RENT + jan.SERVICE - jan.cost);
  const sumProfit = admin.months!.reduce((a, m) => a + (m.profit ?? 0), 0);
  assert.equal(Math.round(sumProfit * 100) / 100, admin.kpi.grossProfit, 'graf i KPI imaju istu dobit');
});

test('izvještaji po stavkama: popust na račun raspoređen, storna i odobrenja umanjuju — klijent/model = prihod po mjesecima', async () => {
  const s = await setupCompany({ items: 4 });
  const year = Number(today().slice(0, 4));
  const sale = (lines: Array<{ i: number; price: number }>, date: string, discountPct = 0) =>
    transaction(async (tx) => {
      const d = await createDraft(tx, s.actor, {
        type: 'SALE', partnerId: s.partner.id, date, vatRate: 25, discountPct,
        lines: lines.map((l) => ({ kind: 'DEVICE' as const, itemId: s.items[l.i].id, modelId: s.model.id, description: 'Sunmi T2s', qty: 1, unitPrice: l.price })),
      });
      await issueInvoice(tx, s.actor, d.id);
      return d;
    });
  // račun s 10 % popusta: 200 + 150 − 35 = 315
  const a = await sale([{ i: 0, price: 200 }, { i: 1, price: 150 }], `${year}-01-10`, 10);
  // račun koji se stornira
  const b = await sale([{ i: 2, price: 100 }], `${year}-01-12`);
  await transaction((tx) => stornoInvoice(tx, s.actor, b.id, { date: `${year}-01-20` }));
  // odobrenje 45 na prvi račun
  await transaction((tx) => creditNote(tx, s.actor, a.id, { date: `${year}-01-25`, description: 'Popust', netAmount: 45 }));

  const run = async (slug: string) => {
    const def = findReport(slug)!;
    return runReport(def, s.companyId, readFilters(def, new URLSearchParams({ godina: String(year) })), { canSeeCost: true });
  };
  const monthly = await run('prihod-po-mjesecima');
  const monthlyTotal = monthly.rows.reduce((x, r) => x + Number(r.total), 0);
  assert.equal(Math.round(monthlyTotal * 100) / 100, 270);
  const cm = await run('prihod-klijent-model');
  const cmTotal = cm.rows.reduce((x, r) => x + Number(r.revenue), 0);
  assert.equal(Math.round(cmTotal * 100) / 100, Math.round(monthlyTotal * 100) / 100, 'zbroj klijent/model = prihod po mjesecima');
  assert.equal(cm.rows[0].qty, 2, 'stornirani komad se ne broji');

  // marža i prosječna cijena: važeći računi, nakon popusta i odobrenja (315 − 45 = 270 za 2 komada)
  const marza = await run('marza-po-modelu');
  assert.equal(marza.rows[0].revenue, 270);
  assert.equal(marza.rows[0].qty, 2);
  const avg = await run('prosjecna-prodajna-cijena');
  assert.equal(avg.rows[0].avgPrice, 135);
  const pieces = await run('uredaji-po-komadima');
  assert.equal(pieces.rows[0].revenue, 270);
  assert.equal(pieces.rows[0].sold, 2);
});

test('prijava: pokušaji u bazi — istodobni zahtjevi ne zaobilaze granicu, uspjeh briše neuspjehe, stari zapisi se čiste', async () => {
  const email = `x${uniq()}@t.hr`;
  const keys = loginKeys('staff', email, `198.51.100.${Math.floor(Math.random() * 200)}`);
  const res = await Promise.all(Array.from({ length: 12 }, () => beginAttempt(keys)));
  assert.equal(res.filter((r) => r.allowed).length, 5, 'točno 5 pokušaja po adresi, i istodobno');
  // zaključani pokušaji se ne pamte (broj redaka ostaje ograničen)
  assert.equal(await db.loginAttempt.count({ where: { key: keys[0].key } }), 5);
  assert.equal((await beginAttempt(keys)).allowed, false);
  // uspješna prijava (npr. nakon isteka) briše neuspjehe adrese
  await succeedAttempt(res.find((r) => r.allowed)!);
  assert.equal(await db.loginAttempt.count({ where: { key: keys[0].key } }), 0);
  assert.equal((await beginAttempt(keys)).allowed, true);

  // IP granica vrijedi za različite adrese s iste IP
  const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
  let allowed = 0;
  for (let i = 0; i < 25; i++) if ((await beginAttempt(loginKeys('portal', `p${i}${uniq()}@t.hr`, ip))).allowed) allowed++;
  assert.equal(allowed, 20);

  const old = await db.loginAttempt.create({ data: { key: `staff:acc:old${uniq()}`, at: new Date(Date.now() - 2 * 86_400_000) } });
  await cleanupLoginAttempts(true);
  assert.equal(await db.loginAttempt.count({ where: { id: old.id } }), 0);
  await db.loginAttempt.deleteMany({ where: { key: { in: [keys[0].key, keys[1].key, `portal:ip:${ip}`] } } });
});

test('kopija za vraćanje: prevelika se odbija jasnom porukom (bez učitavanja cijele u memoriju)', async () => {
  const dir = path.join(os.tmpdir(), `f-backups-${uniq()}`);
  process.env.BACKUP_DIR = dir;
  const companyId = `c${uniq()}`;
  await mkdir(path.join(dir, companyId), { recursive: true });
  const name = 'kopija-2026-01-01-120000-rucna.json.gz';
  await writeFile(path.join(dir, companyId, name), gzipSync(Buffer.from(JSON.stringify({ rows: 'x'.repeat(5000) }))));
  await assert.rejects(readBackup(companyId, name, 1000), /prevelika/);
  const ok = (await readBackup(companyId, name, 100_000)) as { rows: string };
  assert.equal(ok.rows.length, 5000);
  await rm(dir, { recursive: true, force: true });
  delete process.env.BACKUP_DIR;
  void companies;
});
