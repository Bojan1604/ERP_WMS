/**
 * Izvještaji (F1–F4): svi izvještaji se izvršavaju sa svim filtrima (valjan SQL),
 * novi izvještaji daju očekivane brojke, a bez prava „costs" nema nabavnih stupaca.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { createDraft, issueInvoice } from '../../src/server/services/invoices';
import { attachItems } from '../../src/server/services/rentals';
import { REPORTS, readFilters, runReport, findReport } from '../../src/server/queries/reports';
import { fromISO, today } from '../../src/domain/dates';
import { cleanup, setupCompany } from './f-helpers';

before(async () => {
  await db.$connect();
});
after(async () => {
  await cleanup();
  await db.$disconnect();
});

async function seed() {
  const s = await setupCompany({ items: 6 });
  const year = Number(today().slice(0, 4));
  // prodaja dva uređaja
  const draft = await transaction((tx) =>
    createDraft(tx, s.actor, {
      type: 'SALE', partnerId: s.partner.id, date: `${year}-02-10`, vatRate: 25,
      lines: [
        { kind: 'DEVICE', itemId: s.items[0].id, modelId: s.model.id, description: 'Sunmi T2s', qty: 1, unitPrice: 200 },
        { kind: 'DEVICE', itemId: s.items[1].id, modelId: s.model.id, description: 'Sunmi T2s', qty: 1, unitPrice: 150 },
      ],
    }),
  );
  await transaction((tx) => issueInvoice(tx, s.actor, draft.id));
  // najam dva uređaja
  const contract = await db.contract.create({ data: { companyId: s.companyId, number: 'UG-F-1', partnerId: s.partner.id, startDate: fromISO(`${year}-01-01`), billing: 'MONTHLY' } });
  await transaction((tx) => attachItems(tx, s.actor, contract.id, [{ itemId: s.items[2].id, monthly: 20 }, { itemId: s.items[3].id, monthly: 30 }], { issueDate: `${year}-01-01` }));
  return { ...s, year };
}

test('izvještaji: svaki se izvršava bez filtara i sa svim filtrima', async () => {
  const s = await seed();
  const ids = {
    partner: s.partner.id, kategorija: s.category.id, model: s.model.id, skladiste: s.wh.id, dobavljac: s.supplier.id,
    status: (await db.itemStatus.findFirstOrThrow({ where: { companyId: s.companyId, kind: 'SOLD' } })).id,
  };
  for (const def of REPORTS) {
    for (const params of [
      new URLSearchParams(),
      new URLSearchParams({ godina: 'sve' }),
      new URLSearchParams({ godina: String(s.year), od: `${s.year}-01-01`, do: `${s.year}-12-31`, vrsta: 'prodaja,najam', dana: '90', ...ids }),
    ]) {
      const f = readFilters(def, params);
      const res = await runReport(def, s.companyId, f, { canSeeCost: true });
      assert.ok(Array.isArray(res.rows), def.slug);
      const hidden = await runReport(def, s.companyId, f, { canSeeCost: false });
      assert.ok(!hidden.columns.some((c) => c.cost), `${def.slug}: nabavni stupci bez prava`);
    }
  }
});

test('izvještaji: uređaji po komadima, klijent/model, najam po kategoriji, uvoz', async () => {
  const s = await seed();
  const run = async (slug: string, params: Record<string, string> = {}) => {
    const def = findReport(slug)!;
    return runReport(def, s.companyId, readFilters(def, new URLSearchParams(params)), { canSeeCost: true });
  };
  const pieces = await run('uredaji-po-komadima');
  assert.equal(pieces.rows.length, 1);
  assert.equal(pieces.rows[0].sold, 2);
  assert.equal(pieces.rows[0].rented, 2);
  assert.equal(pieces.rows[0].revenue, 350);
  assert.equal(pieces.rows[0].monthly, 50);
  // samo najam
  const onlyRent = await run('uredaji-po-komadima', { vrsta: 'najam' });
  assert.equal(onlyRent.rows[0].total, 2);

  const cm = await run('prihod-klijent-model');
  assert.equal(cm.rows.length, 1);
  assert.equal(cm.rows[0].qty, 2);
  assert.equal(cm.rows[0].avgPrice, 175);

  const byCat = await run('najam-po-kategoriji');
  assert.equal(byCat.rows[0].category, 'POS');
  assert.equal(byCat.rows[0].count, 2);
  assert.equal(byCat.rows[0].monthly, 50);

  const rcm = await run('najam-klijent-model');
  assert.equal(rcm.rows[0].devices, 2);
  assert.equal(rcm.rows[0].monthly, 50);

  const imp = await run('uvoz-po-mjesecima', { godina: '2026' });
  assert.equal(imp.rows[0].count, 6);
  assert.equal(imp.rows[0].value, 600);

  const avg = await run('prosjecna-prodajna-cijena');
  assert.equal(avg.rows[0].qty, 2);
  assert.equal(avg.rows[0].avgPrice, 175);

  // drugi partner u filtru → nema prodaje
  const other = await db.partner.create({ data: { companyId: s.companyId, name: 'Drugi' } });
  const none = await run('prihod-klijent-model', { partner: other.id });
  assert.equal(none.rows.length, 0);
});

test('izvještaji: bez prava „costs" izvještaj marže je prazan, a stupci nabavne skriveni', async () => {
  const s = await seed();
  const marza = findReport('marza-po-modelu')!;
  const res = await runReport(marza, s.companyId, readFilters(marza, new URLSearchParams()), { canSeeCost: false });
  assert.equal(res.rows.length, 0);
  const imp = findReport('uvoz-po-mjesecima')!;
  const r2 = await runReport(imp, s.companyId, readFilters(imp, new URLSearchParams({ godina: '2026' })), { canSeeCost: false });
  assert.ok(!r2.columns.some((c) => c.key === 'value'));
  assert.equal(r2.rows[0].count, 6);
});
