/**
 * Straničenje velikih popisa (QA t6): stranica iz baze, zbrojevi preko svih redaka,
 * izvoz (bez stranice) sadrži sve. Izvještaji, izlaz iz skladišta, troškovi, kartica
 * partnera i popis uređaja klijenta.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { createDraft, issueInvoice } from '../../src/server/services/invoices';
import { statusFor } from '../../src/server/services/items';
import { findReport, readFilters, runReport } from '../../src/server/queries/reports';
import { reservedGroups } from '../../src/server/queries/warehouse';
import { expensesForYear, parseExpenseFilters } from '../../src/server/queries/expenses';
import { partnerLedger } from '../../src/server/queries/partners';
import { clientSheet } from '../../src/server/queries/client-sheet';
import { fromISO, today } from '../../src/domain/dates';
import { cleanup, setupCompany } from './f-helpers';

before(async () => {
  await db.$connect();
});
after(async () => {
  await cleanup();
  await db.$disconnect();
});

const year = Number(today().slice(0, 4));

async function sell(s: Awaited<ReturnType<typeof setupCompany>>, itemIdx: number[], date = `${year}-02-10`) {
  const draft = await transaction((tx) =>
    createDraft(tx, s.actor, {
      type: 'SALE', partnerId: s.partner.id, date, vatRate: 25,
      lines: itemIdx.map((i) => ({ kind: 'DEVICE' as const, itemId: s.items[i].id, modelId: s.model.id, description: 'Sunmi T2s', qty: 1, unitPrice: 100 + i * 10 })),
    }),
  );
  return transaction((tx) => issueInvoice(tx, s.actor, draft.id));
}

test('izvještaji: stranica iz baze (otpisani, nenaplaćeni) i rezanje u runReport, zbrojevi preko svega', async () => {
  const s = await setupCompany({ items: 6 });
  const off = await transaction((tx) => statusFor(tx, s.companyId, 'WRITTEN_OFF'));
  for (const it of s.items.slice(0, 5)) {
    await db.item.update({ where: { id: it.id }, data: { state: 'WRITTEN_OFF', statusId: off.id, writeOffDate: fromISO(`${year}-03-01`), writeOffReason: 'test' } });
  }
  const def = findReport('otpisani-uredaji')!;
  const f = readFilters(def, new URLSearchParams());
  const page = await runReport(def, s.companyId, f, { canSeeCost: true, page: { skip: 2, take: 2 } });
  assert.equal(page.rows.length, 2);
  assert.equal(page.rowCount, 5);
  assert.deepEqual(page.totals, { serial: '5 uređaja', cost: 500 });
  const all = await runReport(def, s.companyId, f, { canSeeCost: true });
  assert.equal(all.rows.length, 5);
  assert.equal(all.rowCount, undefined);
  assert.deepEqual(all.rows.slice(2, 4), page.rows);

  // nenaplaćeni: tri otvorena računa
  const s2 = await setupCompany({ items: 3 });
  for (const i of [0, 1, 2]) await sell(s2, [i]);
  const nr = findReport('nenaplaceni-racuni')!;
  const f2 = readFilters(nr, new URLSearchParams());
  const p2 = await runReport(nr, s2.companyId, f2, { canSeeCost: true, page: { skip: 0, take: 2 } });
  const a2 = await runReport(nr, s2.companyId, f2, { canSeeCost: true });
  assert.equal(p2.rows.length, 2);
  assert.equal(p2.rowCount, 3);
  assert.equal(a2.rows.length, 3);
  assert.equal(p2.totals?.open, a2.rows.reduce((a, r) => a + Number(r.open), 0));

  // izvještaj bez vlastitog straničenja: runReport reže retke, zbroj ostaje preko svih
  const zp = findReport('zarada-po-uredaju')!;
  const fz = readFilters(zp, new URLSearchParams({ godina: 'sve' }));
  const zAll = await runReport(zp, s2.companyId, fz, { canSeeCost: true });
  const zPage = await runReport(zp, s2.companyId, fz, { canSeeCost: true, page: { skip: 0, take: 1 } });
  assert.equal(zAll.rows.length, 3);
  assert.equal(zPage.rows.length, 1);
  assert.equal(zPage.rowCount, 3);
  assert.deepEqual(zPage.totals, zAll.totals);
});

test('zarada po uređaju: zadano tekuća godina, „Sve" = cijeli vijek uređaja', async () => {
  const s = await setupCompany({ items: 2 });
  await sell(s, [0], `${year - 1}-06-01`);
  await sell(s, [1]);
  const def = findReport('zarada-po-uredaju')!;
  const cur = await runReport(def, s.companyId, readFilters(def, new URLSearchParams()), { canSeeCost: true });
  const all = await runReport(def, s.companyId, readFilters(def, new URLSearchParams({ godina: 'sve' })), { canSeeCost: true });
  assert.deepEqual(cur.rows.map((r) => r.serial), ['SN1']);
  assert.deepEqual(new Set(all.rows.map((r) => r.serial)), new Set(['SN0', 'SN1']));
  const sn1 = all.rows.find((r) => r.serial === 'SN1')!;
  assert.equal(sn1.revenue, 110);
  assert.equal(sn1.invoices, 1);
  assert.equal(sn1.profit, 10);
});

test('izlaz iz skladišta: skupine po partneru, stranica preko skupina', async () => {
  const s = await setupCompany({ items: 5 });
  const other = await db.partner.create({ data: { companyId: s.companyId, name: 'Aaa kupac' } });
  const reserved = await transaction((tx) => statusFor(tx, s.companyId, 'RESERVED'));
  for (const [i, it] of s.items.entries()) {
    await db.item.update({ where: { id: it.id }, data: { state: 'RESERVED', statusId: reserved.id, outPartnerId: i < 2 ? other.id : s.partner.id, outAt: new Date() } });
  }
  const p1 = await reservedGroups(s.companyId, { skip: 0, take: 3 });
  assert.equal(p1.total, 5);
  assert.deepEqual(p1.groups.map((g) => [g.partnerName, g.count, g.items.length, g.from]), [['Aaa kupac', 2, 2, 0], ['Kupac d.o.o.', 3, 1, 0]]);
  assert.equal(p1.groups[1].cost, 300);
  const p2 = await reservedGroups(s.companyId, { skip: 3, take: 3 });
  assert.deepEqual(p2.groups.map((g) => [g.partnerName, g.items.length, g.from]), [['Kupac d.o.o.', 2, 1]]);
  const seen = [...p1.groups, ...p2.groups].flatMap((g) => g.items.map((i) => i.id));
  assert.equal(new Set(seen).size, 5);
});

test('troškovi: stranica redaka, zbrojevi i obrazac samo za prikazane', async () => {
  const s = await setupCompany({ items: 0 });
  for (let i = 1; i <= 3; i++) {
    await db.expense.create({ data: { companyId: s.companyId, date: fromISO(`${year}-01-0${i}`), description: `Trošak ${i}`, netAmount: 10 * i, vatAmount: 0, source: 'MANUAL', partnerId: s.partner.id } });
  }
  const f = parseExpenseFilters({ year: String(year) });
  const all = await expensesForYear(s.companyId, f);
  const page = await expensesForYear(s.companyId, f, { skip: 0, take: 2 });
  assert.equal(all.rows.length, 3);
  assert.equal(page.rows.length, 2);
  assert.equal(page.rowCount, 3);
  assert.equal(page.totals.net, 60);
  assert.deepEqual(page.rows, all.rows.slice(0, 2));
  assert.equal(page.rows[0].partner, 'Kupac d.o.o.');
  assert.equal(Object.keys(page.manual).length, 2);
});

test('kartica partnera i popis uređaja klijenta po stranicama', async () => {
  const s = await setupCompany({ items: 3 });
  for (const i of [0, 1, 2]) await sell(s, [i]);
  const full = await partnerLedger(s.companyId, s.partner.id);
  const page = await partnerLedger(s.companyId, s.partner.id, { skip: 0, take: 2 });
  assert.equal(full.total, 3);
  assert.equal(page.rows.length, 2);
  assert.deepEqual(page.rows, full.rows.slice(1));
  assert.equal(page.debit, full.debit);
  assert.equal(page.balance, full.rows.at(-1)!.balance);

  const sheet = await clientSheet(s.companyId, s.partner.id, { view: 'prodano', limit: 2, skip: 2 });
  assert.equal(sheet?.total, 3);
  assert.equal(sheet?.rows.length, 1);
  assert.ok(!sheet?.truncated);
});
