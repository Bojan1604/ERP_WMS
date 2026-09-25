/**
 * Prodaja (područje B) nad testnom bazom: predračun (brojač, pretvaranje),
 * miješani račun (prodaja + najam), račun za najam koji otvara ugovor, stanja
 * eRačuna s demo posrednikom i ponuda za najam → ugovor → račun.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../src/server/db';
import { bootstrapCompany } from '../../src/server/services/company';
import { statusFor, type Actor } from '../../src/server/services/items';
import { createDraft, deleteDraft, issueInvoice, stornoInvoice, updateDraft, type InvoiceInput } from '../../src/server/services/invoices';
import { coveredPeriods } from '../../src/server/services/contract-items';
import { pendingForCompany } from '../../src/server/services/rentals';
import { convertQuote, convertQuoteToContract, saveQuote } from '../../src/server/services/quotes';
import { openInvoiceContract } from '../../src/server/services/invoice-rent';
import { afterIssue, sendEInvoice } from '../../src/server/fiscal';
import { refreshEInvoiceStatus, reportWithoutSending, resetEInvoiceTrace, validateEInvoice } from '../../src/server/fiscal/einvoice-ops';
import { invoiceUbl } from '../../src/server/fiscal/ubl-source';
import { fromISO, today } from '../../src/domain/dates';

assert.match(process.env.DATABASE_URL ?? '', /wms_test/, 'Integracijski testovi smiju raditi samo nad testnom bazom (wms_test).');
process.env.AUTH_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';

const companies: string[] = [];
const OIB = '12345678903';

async function setup(opts: { einvoice?: boolean } = {}) {
  const c = await db.company.create({
    data: {
      name: `B ${Date.now()}-${Math.random()}`,
      oib: OIB,
      iban: 'HR1210010051863000160',
      invoicePremises: 'B1',
      kpdSale: '26.20.11',
      kpdRent: '77.33.01',
      kpdService: '62.90.10',
      ...(opts.einvoice ? { fiscalEnabled: true, fiscalEnv: 'TEST', eInvoiceProvider: 'demo', paymentModel: 'HR01', eInvoicePaymentMeans: '58' } : {}),
    },
  });
  companies.push(c.id);
  await transaction((tx) => bootstrapCompany(tx, c.id));
  const u = await db.user.create({ data: { companyId: c.id, email: `b${Date.now()}${Math.random()}@t.hr`, name: 'Prodavač', passwordHash: 'x', role: 'ADMIN', oib: OIB } });
  const actor: Actor = { id: u.id, name: u.name, companyId: c.id };
  const model = await db.deviceModel.create({ data: { companyId: c.id, brand: 'Sunmi', name: 'T2s', rentPrice: 20 } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { companyId: c.id } });
  const partner = await db.partner.create({ data: { companyId: c.id, name: 'Kupac d.o.o.', oib: '69435151530' } });
  const foreign = await db.partner.create({ data: { companyId: c.id, name: 'Kunde GmbH', country: 'DE', vatId: 'DE123456789' } });
  const stock = await transaction((tx) => statusFor(tx, c.id, 'IN_STOCK'));
  const items = [];
  for (let i = 0; i < 6; i++) {
    items.push(
      await db.item.create({
        data: { companyId: c.id, serial: `B-SN${i}`, modelId: model.id, statusId: stock.id, state: 'IN_STOCK', warehouseId: wh.id, cost: 100, importDate: fromISO('2026-01-01') },
      }),
    );
  }
  return { companyId: c.id, actor, model, partner, foreign, items };
}

type S = Awaited<ReturnType<typeof setup>>;

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

const baseInvoice = (s: S, over: Partial<InvoiceInput>): InvoiceInput => ({
  type: 'SALE',
  partnerId: s.partner.id,
  date: today(),
  vatRate: 25,
  lines: [],
  ...over,
});

test('predračun: vlastiti brojač (PRED), ponuda svoj (PON); pretvaranje u račun', async () => {
  const s = await setup();
  const d = today();
  const year = d.slice(0, 4);
  const mk = (kind: 'QUOTE' | 'PROFORMA') =>
    transaction((tx) =>
      saveQuote(tx, s.actor, null, { kind, partnerId: s.partner.id, date: d, vatRate: 25, lines: [{ kind: 'DEVICE', itemId: s.items[0].id, modelId: s.model.id, description: 'Sunmi T2s', qty: 1, unitPrice: 300 }] }),
    );
  const p1 = await mk('PROFORMA');
  const q1 = await mk('QUOTE');
  const p2 = await mk('PROFORMA');
  assert.equal(p1.number, `PRED-${year}-0001`);
  assert.equal(p2.number, `PRED-${year}-0002`);
  assert.equal(q1.number, `PON-${year}-0001`);
  assert.equal(p1.kind, 'PROFORMA');

  const inv = await transaction((tx) => convertQuote(tx, s.actor, p1.id, {}));
  assert.equal(inv.description, `Po predračunu ${p1.number}`);
  const q = await db.quote.findUniqueOrThrow({ where: { id: p1.id } });
  assert.equal(q.invoiceId, inv.id);
  assert.equal(q.status, 'ACCEPTED');
  // pretvoren predračun se više ne mijenja ni ne pretvara ponovno
  await assert.rejects(transaction((tx) => convertQuote(tx, s.actor, p1.id, {})), /već pretvorena/);
  await transaction((tx) => issueInvoice(tx, s.actor, inv.id));
  const item = await db.item.findUniqueOrThrow({ where: { id: s.items[0].id } });
  assert.equal(item.state, 'SOLD');
  // zadana KPD šifra prodaje s postavki firme
  const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv.id } });
  assert.equal(line.kpd, '26.20.11');
});

test('miješani račun: prodajna stavka skida sa stanja, stavka najma ide na ugovor i pokriva razdoblje', async () => {
  const s = await setup();
  const [sold, rented] = s.items;
  const draft = await transaction(async (tx) => {
    const c = await openInvoiceContract(tx, s.actor, s.partner.id, { startDate: today(), billing: 'MONTHLY', months: 12, seasonFrom: null, seasonTo: null });
    return createDraft(
      tx,
      s.actor,
      baseInvoice(s, {
        contractId: c.id,
        lines: [
          { kind: 'DEVICE', itemId: sold.id, description: 'Sunmi T2s', qty: 1, unitPrice: 300 },
          { kind: 'DEVICE', itemId: rented.id, description: 'Najam Sunmi T2s', qty: 1, unitPrice: 50, monthly: 50, months: 1, lineType: 'RENT' },
          { kind: 'MANUAL', description: 'Instalacija', qty: 1, unitPrice: 40 },
        ],
      }),
    );
  });
  const lines = await db.invoiceLine.findMany({ where: { invoiceId: draft.id }, orderBy: { sort: 'asc' } });
  assert.deepEqual(lines.map((l) => l.lineType), [null, 'RENT', null]);
  assert.equal(Number(lines[0].cost), 100, 'prodaja nosi nabavnu vrijednost');
  assert.equal(Number(lines[1].cost), 0, 'najam nema nabavnu vrijednost u marži');
  assert.equal(lines[1].kpd, '77.33.01', 'zadana KPD šifra najma');

  await transaction((tx) => issueInvoice(tx, s.actor, draft.id));
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(inv.period, today().slice(0, 7));
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: sold.id } })).state, 'SOLD');
  const r = await db.item.findUniqueOrThrow({ where: { id: rented.id }, include: { contractItem: true } });
  assert.equal(r.state, 'RENTED');
  assert.equal(r.contractItem?.contractId, inv.contractId);
  assert.equal(Number(r.contractItem?.monthly), 50);

  const cov = (await coveredPeriods(db, [inv.contractId!])).get(inv.contractId!) ?? new Set();
  assert.ok(cov.has(`${rented.id}|${inv.period}`), 'razdoblje uređaja u najmu je fakturirano');
  assert.ok(![...cov].some((k) => k.startsWith(sold.id)), 'prodani uređaj ne ulazi u pokrivenost najma');
  const pending = await pendingForCompany(db, s.companyId, { contractId: inv.contractId! });
  assert.ok(!pending.some((p) => p.period === inv.period), 'izdana rata se više ne traži');

  // storno vraća prodani uređaj na skladište i oslobađa razdoblje najma
  await transaction((tx) => stornoInvoice(tx, s.actor, inv.id));
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: sold.id } })).state, 'IN_STOCK');
  const cov2 = (await coveredPeriods(db, [inv.contractId!])).get(inv.contractId!) ?? new Set();
  assert.ok(!cov2.has(`${rented.id}|${inv.period}`));
});

test('račun za najam: „+ Novi ugovor" otvara ugovor, uređaji se vežu pri izdavanju; prazan ugovor se briše s nacrtom', async () => {
  const s = await setup();
  const [a, b] = s.items;
  const start = today();
  const lines = [
    { kind: 'DEVICE' as const, itemId: a.id, description: 'Najam Sunmi T2s', qty: 1, unitPrice: 150, monthly: 50, months: 3 },
    { kind: 'DEVICE' as const, itemId: b.id, description: 'Najam Sunmi T2s', qty: 1, unitPrice: 90, monthly: 30, months: 3 },
  ];
  // nacrt s novim ugovorom pa brisanje nacrta — ugovor bez uređaja nestaje
  const tmp = await transaction(async (tx) => {
    const c = await openInvoiceContract(tx, s.actor, s.partner.id, { startDate: start, billing: 'QUARTERLY', months: 24, seasonFrom: null, seasonTo: null });
    return createDraft(tx, s.actor, baseInvoice(s, { type: 'RENT', contractId: c.id, lines }));
  });
  await transaction((tx) => deleteDraft(tx, s.actor, tmp.id));
  assert.equal(await db.contract.count({ where: { id: tmp.contractId! } }), 0);

  const draft = await transaction(async (tx) => {
    const c = await openInvoiceContract(tx, s.actor, s.partner.id, { startDate: start, billing: 'QUARTERLY', months: 24, seasonFrom: null, seasonTo: null });
    return createDraft(tx, s.actor, baseInvoice(s, { type: 'RENT', contractId: c.id, lines }));
  });
  const c = await db.contract.findUniqueOrThrow({ where: { id: draft.contractId! } });
  assert.equal(c.billing, 'QUARTERLY');
  assert.ok(c.endDate, 'trajanje zadaje kraj ugovora');
  assert.equal(await db.contractItem.count({ where: { contractId: c.id } }), 0, 'uređaji se vežu tek pri izdavanju');
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: a.id } })).state, 'IN_STOCK');

  await transaction((tx) => issueInvoice(tx, s.actor, draft.id));
  const cis = await db.contractItem.findMany({ where: { contractId: c.id }, orderBy: { monthly: 'desc' } });
  assert.deepEqual(cis.map((x) => Number(x.monthly)), [50, 30]);
  assert.deepEqual(cis[0].plan, [], 'isti uvjeti kao ugovor — bez vlastitog plana');
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(inv.period, start.slice(0, 7));
  for (const id of [a.id, b.id]) assert.equal((await db.item.findUniqueOrThrow({ where: { id } })).state, 'RENTED');
  const pending = await pendingForCompany(db, s.companyId, { contractId: c.id });
  assert.ok(!pending.some((p) => p.period === inv.period));

  // račun za najam na postojeći ugovor bez ugovora ne prolazi
  const bad = await transaction((tx) => createDraft(tx, s.actor, baseInvoice(s, { type: 'RENT', lines: [{ ...lines[0], itemId: s.items[2].id }] })));
  await assert.rejects(transaction((tx) => issueInvoice(tx, s.actor, bad.id)), /ugovor/);
  // postojeći ugovor, druga učestalost → uređaj dobiva vlastiti plan
  await transaction((tx) => updateDraft(tx, s.actor, bad.id, baseInvoice(s, { type: 'RENT', contractId: c.id, lines: [{ ...lines[0], itemId: s.items[2].id, months: 1, unitPrice: 50 }] })));
  await transaction((tx) => issueInvoice(tx, s.actor, bad.id));
  const ci = await db.contractItem.findUniqueOrThrow({ where: { itemId: s.items[2].id } });
  assert.equal(ci.contractId, c.id);
  assert.deepEqual(ci.plan, [{ from: start, billing: 'MONTHLY' }]);
});

test('eRačun (demo): poslan → dostavljen → poništen trag; IR, tip I i provjera; UBL s postavkama plaćanja', async () => {
  const s = await setup({ einvoice: true });
  const mk = (partnerId: string) =>
    transaction(async (tx) => {
      const d = await createDraft(tx, s.actor, baseInvoice(s, { type: 'SERVICE', partnerId, paymentMethod: 'TRANSFER', lines: [{ kind: 'MANUAL', description: 'Usluga', qty: 1, unitPrice: 100 }] }));
      await issueInvoice(tx, s.actor, d.id);
      return d;
    });
  const a = await mk(s.partner.id);
  let inv = await db.invoice.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(inv.eInvoiceStatus, null, 'prije slanja nije poslan');

  const ubl = await invoiceUbl(s.companyId, a.id);
  assert.match(ubl!.xml!, /<cbc:PaymentMeansCode>58<\/cbc:PaymentMeansCode>/);
  assert.match(ubl!.xml!, /<cbc:PaymentID>HR01 /);
  assert.match(ubl!.xml!, /62\.90\.10/, 'zadana KPD šifra usluge');

  assert.ok((await validateEInvoice(a.id, s.actor)).ok);
  const o = await afterIssue(a.id, s.actor);
  assert.ok(o?.ok, o?.message);
  inv = await db.invoice.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(inv.eInvoiceStatus, 'SENT');
  assert.ok(inv.eInvoiceStatusAt);

  const r = await refreshEInvoiceStatus(a.id, s.actor);
  assert.ok(r.ok, r.message);
  inv = await db.invoice.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(inv.eInvoiceStatus, 'DELIVERED');
  assert.match(String((inv.eInvoice as { statusText?: string }).statusText), /DELIVERED/);

  const reset = await resetEInvoiceTrace(a.id, s.actor);
  assert.ok(reset.ok, reset.message);
  inv = await db.invoice.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(inv.eInvoiceStatus, null);
  assert.equal(inv.fiscalStatus, 'FAILED');
  assert.equal((inv.eInvoice as { id?: string }).id, undefined);
  // naknadna dostava ga sama ne šalje; ručno slanje radi
  const auto = await sendEInvoice(a.id, s.actor, { resendUncertain: false });
  assert.ok(auto.skipped);
  const manual = await sendEInvoice(a.id, s.actor);
  assert.ok(manual.ok, manual.message);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: a.id } })).eInvoiceStatus, 'SENT');

  // IR: domaći poslovni kupac izvan AMS-a
  const b = await mk(s.partner.id);
  const ir = await reportWithoutSending(b.id, s.actor, 'IR');
  assert.ok(ir.ok, ir.message);
  inv = await db.invoice.findUniqueOrThrow({ where: { id: b.id } });
  assert.equal(inv.eInvoiceStatus, 'FISCALIZED');
  assert.equal(inv.fiscalStatus, 'SENT');
  assert.equal((await afterIssue(b.id, s.actor)), null, 'već fiskaliziran — ne šalje se ponovno');
  assert.equal((await reportWithoutSending(b.id, s.actor, 'IR')).ok, false);

  // tip I: strani kupac
  const f = await mk(s.foreign.id);
  assert.equal((await reportWithoutSending(f.id, s.actor, 'IR')).ok, false);
  const i = await reportWithoutSending(f.id, s.actor, 'I');
  assert.ok(i.ok, i.message);
  inv = await db.invoice.findUniqueOrThrow({ where: { id: f.id } });
  assert.equal(inv.eInvoiceStatus, 'REPORTED');
  assert.ok(inv.eReportedAt);
});

test('ponuda za najam: stavka najma → ugovor (odabrani uređaj), zatim račun veže prodaju i najam', async () => {
  const s = await setup();
  const [saleItem, rentPick] = s.items;
  const q = await transaction((tx) =>
    saveQuote(tx, s.actor, null, {
      partnerId: s.partner.id,
      date: today(),
      vatRate: 25,
      lines: [
        { kind: 'MODEL', modelId: s.model.id, description: 'Sunmi T2s — najam', qty: 1, unitPrice: 25, lineType: 'RENT' },
        { kind: 'DEVICE', itemId: saleItem.id, modelId: s.model.id, description: 'Sunmi T2s', qty: 1, unitPrice: 300 },
      ],
    }),
  );
  const ql = await db.quoteLine.findMany({ where: { quoteId: q.id }, orderBy: { sort: 'asc' } });
  assert.equal(ql[0].lineType, 'RENT');
  assert.equal(Number(ql[0].monthly), 25);

  await assert.rejects(
    transaction((tx) => convertQuoteToContract(tx, s.actor, q.id, {}, { startDate: today(), billing: 'MONTHLY' })),
    /odaberite točno 1/,
  );
  const c = await transaction((tx) => convertQuoteToContract(tx, s.actor, q.id, { [ql[0].id]: [rentPick.id] }, { startDate: today(), billing: 'MONTHLY', months: 12 }));
  const ci = await db.contractItem.findUniqueOrThrow({ where: { itemId: rentPick.id } });
  assert.equal(ci.contractId, c.id);
  assert.equal(Number(ci.monthly), 25);
  const q2 = await db.quote.findUniqueOrThrow({ where: { id: q.id }, include: { lines: { orderBy: { sort: 'asc' } } } });
  assert.equal(q2.contractId, c.id);
  assert.equal(q2.lines.find((l) => l.lineType === 'RENT')?.itemId, rentPick.id, 'stavka po modelu zamijenjena odabranim uređajem');
  await assert.rejects(transaction((tx) => saveQuote(tx, s.actor, q.id, { partnerId: s.partner.id, date: today(), vatRate: 25, lines: [{ kind: 'MANUAL', description: 'x', qty: 1, unitPrice: 1 }] })), /ugovor/);

  const inv = await transaction((tx) => convertQuote(tx, s.actor, q.id, {}));
  assert.equal(inv.contractId, c.id);
  assert.equal(inv.type, 'SALE');
  const lines = await db.invoiceLine.findMany({ where: { invoiceId: inv.id }, orderBy: { sort: 'asc' } });
  assert.deepEqual(lines.map((l) => l.lineType), ['RENT', null]);
  await transaction((tx) => issueInvoice(tx, s.actor, inv.id));
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: saleItem.id } })).state, 'SOLD');
  const issued = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  const cov = (await coveredPeriods(db, [c.id])).get(c.id) ?? new Set();
  assert.ok(cov.has(`${rentPick.id}|${issued.period}`));
  assert.equal(await db.contractItem.count({ where: { contractId: c.id } }), 1, 'uređaj ostaje jednom na ugovoru');
});

test('popis računa: filtar po stanju eRačuna, više odabira, pretraga po serijskom broju i opisu stavke; birač postojećih najmova', async () => {
  const { listInvoices, readInvoiceFilters, searchDevices } = await import('../../src/server/queries/sales');
  const s = await setup({ einvoice: true });
  const sale = await transaction(async (tx) => {
    const d = await createDraft(tx, s.actor, baseInvoice(s, { paymentMethod: 'TRANSFER', lines: [{ kind: 'DEVICE', itemId: s.items[0].id, description: 'Sunmi T2s', qty: 1, unitPrice: 300 }] }));
    await issueInvoice(tx, s.actor, d.id);
    return d;
  });
  await afterIssue(sale.id, s.actor);
  const other = await transaction(async (tx) => {
    const d = await createDraft(tx, s.actor, baseInvoice(s, { type: 'SERVICE', partnerId: s.foreign.id, lines: [{ kind: 'MANUAL', description: 'Konzultacije daljinski', qty: 1, unitPrice: 50 }] }));
    await issueInvoice(tx, s.actor, d.id);
    return d;
  });
  const page = { skip: 0, take: 50 };
  const ids = async (sp: Record<string, string>) => (await listInvoices(s.companyId, readInvoiceFilters({ godina: 'sve', ...sp }), page)).rows.map((r) => r.id).sort();
  assert.deepEqual(await ids({ eracun: 'SENT' }), [sale.id]);
  assert.deepEqual(await ids({ eracun: 'none' }), [other.id]);
  assert.deepEqual(await ids({ eracun: 'none,SENT' }), [sale.id, other.id].sort());
  assert.deepEqual(await ids({ partner: `${s.partner.id},${s.foreign.id}` }), [sale.id, other.id].sort());
  assert.deepEqual(await ids({ vrsta: 'SERVICE' }), [other.id]);
  assert.deepEqual(await ids({ q: 'B-SN0' }), [sale.id], 'serijski broj uređaja na računu');
  assert.deepEqual(await ids({ q: 'daljinski' }), [other.id], 'opis stavke');

  // postojeći najmovi: uređaj na ugovoru kupca s cijenom s ugovora
  const c = await transaction((tx) => openInvoiceContract(tx, s.actor, s.partner.id, { startDate: today(), billing: 'MONTHLY', months: null, seasonFrom: null, seasonTo: null }));
  const r = await transaction((tx) => createDraft(tx, s.actor, baseInvoice(s, { type: 'RENT', contractId: c.id, lines: [{ kind: 'DEVICE', itemId: s.items[1].id, description: 'Najam', qty: 1, unitPrice: 33, monthly: 33, months: 1 }] })));
  await transaction((tx) => issueInvoice(tx, s.actor, r.id));
  const rented = await searchDevices(s.companyId, { mode: 'rented', partnerId: s.partner.id, onlyPartner: true });
  assert.equal(rented.length, 1);
  assert.equal(rented[0].rent, 33);
  assert.equal(rented[0].rentSource, 'contract');
  assert.equal(rented[0].contractId, c.id);
  assert.equal((await searchDevices(s.companyId, { mode: 'rented', partnerId: s.foreign.id, onlyPartner: true })).length, 0);
});

test('marže: prodani uređaji, skupine po modelu, poslovanje (prihod po vrsti stavke)', async () => {
  const { business, marginGroups, marginTotals, readMarginFilters } = await import('../../src/server/queries/margins');
  const s = await setup();
  await transaction(async (tx) => {
    const c = await openInvoiceContract(tx, s.actor, s.partner.id, { startDate: today(), billing: 'MONTHLY', months: null, seasonFrom: null, seasonTo: null });
    const d = await createDraft(
      tx,
      s.actor,
      baseInvoice(s, {
        contractId: c.id,
        lines: [
          { kind: 'DEVICE', itemId: s.items[0].id, description: 'Sunmi T2s', qty: 1, unitPrice: 200 },
          { kind: 'DEVICE', itemId: s.items[1].id, description: 'Sunmi T2s', qty: 1, unitPrice: 150 },
          { kind: 'DEVICE', itemId: s.items[2].id, description: 'Najam', qty: 1, unitPrice: 40, monthly: 40, months: 1, lineType: 'RENT' },
          { kind: 'MANUAL', description: 'Montaža', qty: 1, unitPrice: 60 },
        ],
      }),
    );
    await issueInvoice(tx, s.actor, d.id);
  });
  const f = readMarginFilters({ godina: 'sve' });
  const t = await marginTotals(s.companyId, f);
  assert.equal(t.sold, 2);
  assert.equal(t.cost, 200);
  assert.equal(t.revenue, 350);
  assert.equal(t.profit, 150);
  const g = await marginGroups(s.companyId, f, 'model');
  assert.equal(g.length, 1);
  assert.equal(g[0].label, 'Sunmi T2s');
  const b = await business(s.companyId, f);
  assert.equal(b.revenue, 450);
  assert.deepEqual(b.byType, { oprema: 350, najam: 40, usluge: 60 });
  assert.equal(b.equipment.cost, 200);
});
