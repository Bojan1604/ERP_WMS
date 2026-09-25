/**
 * Demo podaci: firma koja prodaje i iznajmljuje POS opremu ugostiteljima.
 * Povijest se gradi kronološki kroz iste servise koje koristi aplikacija
 * (izdavanje računa, najam, uplate), pa su podaci dosljedni kao u stvarnom radu.
 *
 *   npm run db:seed        (briše i ponovno stvara demo firmu)
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, type Billing, type Partner, type Prisma } from '@prisma/client';
import { bootstrapCompany } from '../src/server/services/company';
import { changeItemStatus, type Actor } from '../src/server/services/items';
import { createDraft, issueInvoice, markPaid, addPayment } from '../src/server/services/invoices';
import { attachItems, pendingForCompany, issueInstallments } from '../src/server/services/rentals';
import { removeDemoCompany } from '../src/server/services/danger';
import { removeStoredFiles } from '../src/server/mdm/wipe';
import { nextDocNumber } from '../src/server/numbering';
import { addDays, addMonths, fromISO, today, ymd } from '../src/domain/dates';
import { priceFromMargin } from '../src/domain/pricing';
import { r2 } from '../src/domain/money';

const db = new PrismaClient();
const TODAY = today();

// deterministički generator — isti podaci pri svakom pokretanju
let s = 20260923;
const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

const tx = <T,>(fn: (t: Prisma.TransactionClient) => Promise<T>) => db.$transaction(fn, { timeout: 120_000, maxWait: 20_000 });

const CATEGORIES = ['POS uređaji', 'Termalni printeri', 'KDS zasloni', 'Samoposlužni kiosci', 'Tableti', 'Ladice za novac', 'Skeneri'];
const MODELS: Array<{ cat: string; brand: string; name: string; cost: number; rent: number; specs?: string; min?: number }> = [
  { cat: 'POS uređaji', brand: 'Sunmi', name: 'T2s', cost: 420, rent: 29, specs: '15.6", Android 11', min: 5 },
  { cat: 'POS uređaji', brand: 'Sunmi', name: 'D3 Pro', cost: 510, rent: 34, specs: '15.6", Android 13', min: 4 },
  { cat: 'POS uređaji', brand: 'iMin', name: 'Swan 1 Pro', cost: 465, rent: 31, specs: '15.6", Android 11' },
  { cat: 'POS uređaji', brand: 'Elo', name: 'I-Series 4', cost: 890, rent: 55, specs: '15.6", Android 12' },
  { cat: 'POS uređaji', brand: 'Sunmi', name: 'V2s Plus', cost: 245, rent: 18, specs: 'ručni, 6.5", printer', min: 6 },
  { cat: 'Termalni printeri', brand: 'Epson', name: 'TM-T20III', cost: 135, rent: 9, min: 8 },
  { cat: 'Termalni printeri', brand: 'Epson', name: 'TM-m30III', cost: 215, rent: 14, min: 4 },
  { cat: 'Termalni printeri', brand: 'Star', name: 'TSP143IV', cost: 190, rent: 12 },
  { cat: 'KDS zasloni', brand: 'Sunmi', name: 'D2s KDS', cost: 360, rent: 24 },
  { cat: 'Samoposlužni kiosci', brand: 'iMin', name: 'Crane 1', cost: 1450, rent: 89, specs: '21.5", podni' },
  { cat: 'Tableti', brand: 'Samsung', name: 'Galaxy Tab A9+', cost: 205, rent: 14, min: 3 },
  { cat: 'Tableti', brand: 'Lenovo', name: 'Tab M10 Plus', cost: 175, rent: 12 },
  { cat: 'Ladice za novac', brand: 'Posiflex', name: 'CR-4000', cost: 62, rent: 4 },
  { cat: 'Skeneri', brand: 'Zebra', name: 'DS2208', cost: 88, rent: 6 },
];
const SERVICES = [
  { name: 'Instalacija i konfiguracija', unit: 'kom', price: 60, kpd: '62.09.11' },
  { name: 'Dolazak na teren', unit: 'kom', price: 35, kpd: '33.12.19' },
  { name: 'Edukacija osoblja', unit: 'sat', price: 40, kpd: '85.59.13' },
  { name: 'Produljeno jamstvo 12 mj', unit: 'kom', price: 45, kpd: '95.11.10' },
  { name: 'Servis — radni sat', unit: 'sat', price: 38, kpd: '95.11.10' },
];
const CUSTOMERS = [
  ['Caffe bar Mandrać', 'Opatija'], ['Restoran Kod Ribara', 'Split'], ['Pizzeria Napoli', 'Zagreb'], ['Hotel Adriatic', 'Makarska'],
  ['Bistro Lanterna', 'Rijeka'], ['Konoba Stari Mlin', 'Poreč'], ['Pekarnica Zlatni Klas', 'Osijek'], ['Caffe Central', 'Zadar'],
  ['Burger House Maksimir', 'Zagreb'], ['Slastičarnica Vanilija', 'Varaždin'], ['Restoran Panorama', 'Dubrovnik'], ['Beach bar Laguna', 'Novalja'],
  ['Kantina Sljeme', 'Zagreb'], ['Hostel Sunce', 'Pula'], ['Grill Dalmacija', 'Šibenik'], ['Bar Rustica', 'Karlovac'],
  ['Gostionica Tri Lipe', 'Čakovec'], ['Sushi Bar Umami', 'Zagreb'], ['Caffe Galerija', 'Split'], ['Restoran Zrno', 'Samobor'],
];
const SUPPLIERS: Array<{ name: string; city: string; country: string; oib?: string }> = [
  { name: 'Distributer POS d.o.o.', city: 'Zagreb', country: 'HR', oib: '69435151530' },
  { name: 'Epson Europe B.V.', city: 'Amsterdam', country: 'NL' },
  { name: 'Shenzhen Sunmi Technology', city: 'Shenzhen', country: 'CN' },
  { name: 'Barkod Sustavi d.o.o.', city: 'Split', country: 'HR' },
];

/**
 * Brisanje demo firme — samo one s oznakom isDemo (nikad druge firme istog naziva).
 * Korisnici s pristupom drugoj firmi vraćaju se u nju (removeDemoCompany).
 */
async function deleteCompany(companyId: string) {
  const r = await tx((t) => removeDemoCompany(t, companyId));
  await removeStoredFiles(r.mdmFiles);
}

async function main() {
  const t0 = Date.now();
  // „Vrati demo podatke" u programu predaje id svoje demo firme; inače (npm run db:seed) — demo firme tog naziva
  const only = process.env.SEED_DEMO_COMPANY_ID;
  const existing = await db.company.findMany({ where: only ? { id: only, isDemo: true } : { name: 'Demo Oprema d.o.o.', isDemo: true }, select: { id: true } });
  if (only && !existing.length) throw new Error('Demo firma ne postoji.');
  for (const c of existing) await deleteCompany(c.id);

  const company = await db.company.create({
    data: {
      name: 'Demo Oprema d.o.o.',
      // samo demo firma smije „Vrati demo podatke" (Postavke → Podaci)
      isDemo: true,
      oib: '12345678903',
      vatId: 'HR12345678903',
      address: 'Radnička cesta 80',
      zip: '10000',
      city: 'Zagreb',
      iban: 'HR1210010051863000160',
      bank: 'Zagrebačka banka',
      email: 'info@demo-oprema.hr',
      phone: '+385 1 555 0101',
      web: 'www.demo-oprema.hr',
      invoicePremises: 'ZG1',
      // KPD 2025 (eRačun, HR-BR-25): najam opreme — stavke rata nose šifru iz postavki firme
      kpdRent: '77.33.12',
      kpdService: '95.11.10',
      invoiceFooter: 'Društvo je upisano u sudski registar Trgovačkog suda u Zagrebu. Temeljni kapital 2.654,46 € uplaćen u cijelosti.',
    },
  });
  const companyId = company.id;
  await tx((t) => bootstrapCompany(t, companyId));

  const hash = await bcrypt.hash('admin123', 10);
  const users = [
    { email: 'admin@demo.hr', name: 'Admin Adminić', role: 'ADMIN' as const },
    { email: 'maja@demo.hr', name: 'Maja Horvat', role: 'MANAGER' as const },
    { email: 'luka@demo.hr', name: 'Luka Kovač', role: 'SALES' as const },
    { email: 'ana@demo.hr', name: 'Ana Babić', role: 'WAREHOUSE' as const },
    { email: 'iva@demo.hr', name: 'Iva Knjigović', role: 'ACCOUNTANT' as const },
  ];
  // demo korisnik koji je imao i drugu firmu (pa nije obrisan) vraća se u demo firmu, pristup drugoj ostaje
  const kept = await db.user.findMany({ where: { email: { in: users.map((u) => u.email) } }, select: { id: true, email: true, companyId: true } });
  for (const k of kept) {
    const u = users.find((x) => x.email === k.email)!;
    await db.userCompany.createMany({ data: [{ userId: k.id, companyId: k.companyId }, { userId: k.id, companyId }], skipDuplicates: true });
    await db.user.update({ where: { id: k.id }, data: { ...u, companyId, passwordHash: hash, active: true } });
  }
  await db.user.createMany({ data: users.filter((u) => !kept.some((k) => k.email === u.email)).map((u) => ({ ...u, companyId, passwordHash: hash })) });
  const admin = await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.hr' } });
  const actor: Actor = { id: admin.id, name: admin.name, companyId };

  // ---------------------------------------------------------------- šifrarnici
  const mainWh = await db.warehouse.findFirstOrThrow({ where: { companyId } });
  const splitWh = await db.warehouse.create({ data: { companyId, name: 'Skladište Split', address: 'Poljička cesta 35, Split', sort: 1 } });
  await db.category.createMany({ data: CATEGORIES.map((name, sort) => ({ companyId, name, sort })) });
  const cats = new Map((await db.category.findMany({ where: { companyId } })).map((c) => [c.name, c.id]));
  for (const m of MODELS) {
    await db.deviceModel.create({
      data: {
        companyId,
        categoryId: cats.get(m.cat),
        brand: m.brand,
        name: m.name,
        code: `${m.brand.slice(0, 3).toUpperCase()}-${m.name.replace(/\W+/g, '').toUpperCase().slice(0, 8)}`,
        kpd: m.cat === 'Termalni printeri' ? '26.20.18' : '26.20.11',
        rentPrice: m.rent,
        specs: m.specs,
        minStock: m.min ?? 0,
        warrantyMonths: 24,
      },
    });
  }
  const models = await db.deviceModel.findMany({ where: { companyId } });
  const modelCost = new Map(models.map((m) => [m.id, MODELS.find((x) => x.name === m.name)!.cost]));
  await db.service.createMany({ data: SERVICES.map((sv) => ({ companyId, ...sv })) });
  const services = await db.service.findMany({ where: { companyId } });

  const suppliers: Partner[] = [];
  for (const sp of SUPPLIERS) {
    suppliers.push(await db.partner.create({ data: { companyId, name: sp.name, city: sp.city, country: sp.country, oib: sp.oib, isCustomer: false, isSupplier: true } }));
  }
  const customers: Partner[] = [];
  for (const [i, [name, city]] of CUSTOMERS.entries()) {
    customers.push(
      await db.partner.create({
        data: {
          companyId,
          name: `${name} (${['j.d.o.o.', 'd.o.o.', 'obrt'][i % 3]})`,
          city,
          address: `${pick(['Ulica kralja Tomislava', 'Obala', 'Trg bana Jelačića', 'Put Firula', 'Vukovarska'])} ${int(1, 120)}`,
          zip: pick(['10000', '21000', '51000', '52440', '23000']),
          oib: String(10000000000 + int(0, 89999999999)).padStart(11, '0'),
          email: `racuni@${name.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '')}.hr`,
          phone: `+385 9${int(1, 9)} ${int(100, 999)} ${int(1000, 9999)}`,
          country: 'HR',
          note: i === 3 ? 'Plaćanje isključivo virmanom, račune slati na računovodstvo@hotel-adriatic.hr' : i === 6 ? 'Dogovoren popust 5 % na sve usluge.' : null,
          paymentTermDays: i % 4 === 0 ? 30 : null,
        },
      }),
    );
  }
  customers.push(await db.partner.create({ data: { companyId, name: 'Gasthaus Alpenblick GmbH', city: 'Graz', country: 'AT', vatId: 'ATU12345678' } }));
  customers.push(await db.partner.create({ data: { companyId, name: 'Kafana Stari Grad', city: 'Beograd', country: 'RS' } }));
  customers.push(await db.partner.create({ data: { companyId, name: 'Interni test partner', city: 'Zagreb', excluded: true, note: 'Isključen iz obračuna — interna oprema' } }));

  // dogovorene cijene
  await db.priceAgreement.createMany({
    data: [
      { companyId, partnerId: customers[3].id, modelId: models[0].id, salePrice: 590, rentPrice: 25 },
      { companyId, partnerId: customers[3].id, modelId: models[5].id, salePrice: 185, rentPrice: 8 },
      { companyId, partnerId: customers[1].id, modelId: models[1].id, rentPrice: 30 },
    ],
  });

  // ---------------------------------------------------------------- kronologija
  const statusRows = await db.itemStatus.findMany({ where: { companyId } });
  const stockStatus = statusRows.find((x) => x.kind === 'IN_STOCK')!;
  const nabava = await db.expenseCategory.findFirstOrThrow({ where: { companyId, name: 'Nabava robe' } });

  let serialNo = 1000;
  const start = '2025-01-01';
  let invoicesIssued = 0;
  const contracts: string[] = [];

  for (let m = 0; ; m++) {
    const monthStart = addMonths(start, m);
    if (monthStart > TODAY) break;
    const monthEnd = [addDays(addMonths(monthStart, 1), -1), TODAY].sort()[0];

    // zaprimanje robe početkom mjeseca
    for (let r = 0; r < int(1, 2); r++) {
      const date = [addDays(monthStart, int(0, 6)), TODAY].sort()[0];
      const supplier = pick(suppliers);
      const wh = rnd() < 0.8 ? mainWh : splitWh;
      await tx(async (t) => {
        const number = await nextDocNumber(t, companyId, 'RECEIPT', Number(date.slice(0, 4)));
        const receipt = await t.goodsReceipt.create({
          data: { companyId, number, date: fromISO(date), supplierId: supplier.id, warehouseId: wh.id, supplierDocNumber: `${int(100, 999)}-${date.slice(0, 4)}`, createdBy: actor.name },
        });
        const rows: Prisma.ItemCreateManyInput[] = [];
        for (let k = 0; k < int(2, 4); k++) {
          const model = pick(models);
          const qty = int(3, model.name.includes('Crane') ? 3 : 10);
          for (let q = 0; q < qty; q++) {
            rows.push({
              companyId,
              serial: `${(model.brand ?? "XX").slice(0, 2).toUpperCase()}${date.slice(2, 4)}${String(serialNo++).padStart(6, '0')}`,
              modelId: model.id,
              statusId: stockStatus.id,
              state: 'IN_STOCK',
              warehouseId: wh.id,
              supplierId: supplier.id,
              receiptId: receipt.id,
              cost: r2(modelCost.get(model.id)! * (0.95 + rnd() * 0.1)),
              importDate: fromISO(date),
            });
          }
        }
        await t.item.createMany({ data: rows });
        const total = r2(rows.reduce((a, x) => a + Number(x.cost), 0));
        await t.goodsReceipt.update({ where: { id: receipt.id }, data: { total } });
        await t.expense.create({
          data: { companyId, date: fromISO(date), categoryId: nabava.id, description: `Nabava robe — primka ${number}`, partnerId: supplier.id, netAmount: total, vatAmount: supplier.country === 'HR' ? r2(total * 0.25) : 0, paid: true, paidDate: fromISO(date), source: 'RECEIPT', receiptId: receipt.id, createdBy: actor.name },
        });
        const created = await t.item.findMany({ where: { receiptId: receipt.id }, select: { id: true } });
        await t.itemEvent.createMany({ data: created.map((i) => ({ companyId, itemId: i.id, type: 'RECEIVED', message: `Zaprimljen — primka ${number}`, refType: 'receipt', refId: receipt.id, userName: actor.name })) });
      });
    }

    // događaji mjeseca: prodaje, novi ugovori i rate — kronološki
    type Ev = { date: string; kind: 'sale' | 'contract' | 'rates' };
    const events: Ev[] = [];
    for (let k = 0; k < int(5, 9); k++) events.push({ date: addDays(monthStart, int(7, 27)), kind: 'sale' });
    if (m % 2 === 0 || rnd() < 0.4) events.push({ date: addDays(monthStart, int(8, 20)), kind: 'contract' });
    for (let d = 1; d <= 28; d += 9) events.push({ date: addDays(monthStart, d - 1), kind: 'rates' });
    events.push({ date: monthEnd, kind: 'rates' });
    events.sort((a, b) => a.date.localeCompare(b.date));

    for (const ev of events) {
      if (ev.date > TODAY) continue;
      if (ev.kind === 'rates') {
        const pending = await tx((t) => pendingForCompany(t, companyId, { now: ev.date }));
        if (pending.length) {
          const old = ev.date < addMonths(TODAY, -2);
          await tx((t) => issueInstallments(t, actor, pending.map((p) => ({ contractId: p.contractId, period: p.period })), { paid: old && rnd() < 0.93, date: ev.date }));
          invoicesIssued += pending.length;
        }
        continue;
      }

      const available = await db.item.findMany({
        where: { companyId, state: 'IN_STOCK', importDate: { lte: fromISO(ev.date) } },
        select: { id: true, serial: true, cost: true, modelId: true },
        take: 60,
        orderBy: { importDate: 'asc' },
      });
      if (available.length < 4) continue;
      const customer = pick(customers.slice(0, 22));

      if (ev.kind === 'contract') {
        const picked = [...available].sort(() => rnd() - 0.5).slice(0, int(2, 6));
        const billing = pick<Billing>(['MONTHLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']);
        const seasonal = rnd() < 0.2;
        await tx(async (t) => {
          const number = await nextDocNumber(t, companyId, 'CONTRACT', Number(ev.date.slice(0, 4)));
          const c = await t.contract.create({
            data: {
              companyId, number, partnerId: customer.id, startDate: fromISO(ev.date),
              firstBillingDate: fromISO(ymd(Number(ev.date.slice(0, 4)), Number(ev.date.slice(5, 7)) + 1, 1)),
              billingDay: 1, billing, billingMode: rnd() < 0.8 ? 'IN_ADVANCE' : 'IN_ARREARS',
              seasonFrom: seasonal ? 5 : null, seasonTo: seasonal ? 10 : null,
              endDate: rnd() < 0.3 ? fromISO(addMonths(ev.date, 24)) : null,
              note: seasonal ? 'Sezonski najam svibanj–listopad' : null, createdBy: actor.name,
            },
          });
          contracts.push(c.id);
          await attachItems(t, actor, c.id, picked.map((i) => ({ itemId: i.id, monthly: MODELS.find((x) => models.find((mm) => mm.id === i.modelId)!.name === x.name)!.rent })), { issueDate: ev.date });
        });
        continue;
      }

      // prodaja: 1–4 uređaja + ponekad usluga
      const picked = [...available].sort(() => rnd() - 0.5).slice(0, int(1, 4));
      const foreign = customer.country !== 'HR';
      const lines = picked.map((i) => {
        const model = models.find((mm) => mm.id === i.modelId)!;
        return {
          kind: 'DEVICE' as const,
          itemId: i.id,
          modelId: model.id,
          description: `${model.brand ?? ''} ${model.name}`.trim(),
          qty: 1,
          unitPrice: priceFromMargin(Number(i.cost), int(22, 40)),
          discountPct: rnd() < 0.2 ? 5 : 0,
          warrantyMonths: rnd() < 0.15 ? 36 : 24,
        };
      });
      const extra = rnd() < 0.55 ? [{ kind: 'SERVICE' as const, serviceId: services[0].id, description: services[0].name, unit: 'kom', qty: 1, unitPrice: 60 }] : [];
      const inv = await tx(async (t) => {
        const d = await createDraft(t, actor, {
          type: 'SALE', partnerId: customer.id, date: ev.date,
          vatRate: foreign ? 0 : 25, taxCategory: foreign ? (customer.country === 'AT' ? 'K' : 'G') : 'S',
          taxExemptReason: foreign ? 'Oslobođeno PDV-a' : null,
          lines: [...lines, ...extra], discountPct: rnd() < 0.1 ? 3 : 0,
        });
        await issueInvoice(t, actor, d.id);
        return d;
      });
      invoicesIssued++;
      // naplata: većina plaćena nakon 3–45 dana, neki djelomično, neki kasne
      const payDate = addDays(ev.date, int(3, 45));
      const roll = rnd();
      if (payDate <= TODAY && roll < 0.82) await tx((t) => markPaid(t, actor, inv.id, payDate));
      else if (payDate <= TODAY && roll < 0.9) {
        const fresh = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
        await tx((t) => addPayment(t, actor, inv.id, { date: payDate, amount: r2(Number(fresh.grandTotal) * 0.4), note: 'Prva rata' }));
      }
    }
  }

  // ---------------------------------------------------------------- stanja uređaja
  const sold = await db.item.findMany({ where: { companyId, state: 'SOLD' }, select: { id: true }, take: 4, orderBy: { issueDate: 'desc' } });
  await tx((t) => changeItemStatus(t, actor, sold.map((i) => i.id), { kind: 'SERVICE', event: { type: 'STATUS', message: 'Status promijenjen u „{status}" — kupac prijavio kvar' } }));
  const so = await db.serviceOrder.findMany({ where: { companyId } });
  const issues = ['Ne pali se nakon pada napona', 'Ekran ne reagira na dodir u donjem dijelu', 'Printer reže papir ukoso', 'Wi-Fi se stalno prekida'];
  for (const [i, o] of so.entries()) {
    await db.serviceOrder.update({
      where: { id: o.id },
      data: {
        issue: issues[i % issues.length],
        status: (['DIAGNOSIS', 'AT_SUPPLIER', 'RECEIVED', 'REPAIRED'] as const)[i % 4],
        diagnosis: i % 4 === 3 ? 'Neispravna matična ploča' : null,
        closedAt: i % 4 === 3 ? fromISO(TODAY) : null,
        cost: i % 4 === 3 ? 45 : 0,
        receivedAt: fromISO(addDays(TODAY, -int(3, 20))),
      },
    });
  }

  const inStock = await db.item.findMany({ where: { companyId, state: 'IN_STOCK' }, select: { id: true }, take: 12, orderBy: { importDate: 'desc' } });
  await tx((t) =>
    changeItemStatus(t, actor, inStock.slice(0, 5).map((i) => i.id), {
      kind: 'RESERVED',
      data: { outAt: new Date(), outById: actor.id, outPartnerId: customers[2].id, outNote: 'Za montažu u petak' },
      event: { type: 'OUT', message: 'Izašlo iz skladišta — za montažu' },
    }),
  );
  const writeOff = inStock.slice(5, 7).map((i) => i.id);
  await tx((t) =>
    changeItemStatus(t, actor, writeOff, {
      kind: 'WRITTEN_OFF',
      data: { writeOffDate: fromISO(TODAY), writeOffReason: 'Oštećeno u transportu', warehouseId: null },
      event: { type: 'WRITE_OFF', message: 'Otpisan — oštećeno u transportu' },
    }),
  );
  const rented = await db.item.findMany({ where: { companyId, state: 'RENTED' }, select: { id: true }, take: 2 });
  await tx((t) => changeItemStatus(t, actor, rented.map((i) => i.id), { kind: 'RETURNING', event: { type: 'RETURNING', message: 'Najavljen povrat s terena' } }));

  // ---------------------------------------------------------------- ponude
  for (let q = 0; q < 9; q++) {
    const date = addDays(TODAY, -int(0, 60));
    const partner = pick(customers.slice(0, 20));
    const qlines = [0, 1, 2].slice(0, int(1, 3)).map(() => {
      const model = pick(models);
      const qty = int(1, 5);
      const price = priceFromMargin(modelCost.get(model.id)!, 35);
      return { kind: 'MODEL' as const, modelId: model.id, description: `${model.brand} ${model.name}`, qty, unitPrice: price, netAmount: r2(qty * price) };
    });
    const net = r2(qlines.reduce((a, l) => a + l.netAmount, 0));
    await tx(async (t) => {
      const number = await nextDocNumber(t, companyId, 'QUOTE', Number(date.slice(0, 4)));
      await t.quote.create({
        data: {
          companyId, number, date: fromISO(date), validUntil: fromISO(addDays(date, 15)), partnerId: partner.id,
          status: pick(['DRAFT', 'SENT', 'SENT', 'ACCEPTED', 'REJECTED'] as const), vatRate: 25,
          netTotal: net, vatTotal: r2(net * 0.25), grandTotal: r2(net * 1.25), createdBy: actor.name,
          lines: { create: qlines.map((l, sort) => ({ ...l, sort })) },
        },
      });
    });
  }

  // ---------------------------------------------------------------- narudžbenice
  for (const [i, status] of (['ORDERED', 'DRAFT', 'PARTIAL'] as const).entries()) {
    const date = addDays(TODAY, -int(2, 25));
    const olines = [pick(models), pick(models)].map((mm) => ({ modelId: mm.id, qty: int(5, 15), unitCost: modelCost.get(mm.id)!, received: status === 'PARTIAL' ? 2 : 0 }));
    await tx(async (t) => {
      const number = await nextDocNumber(t, companyId, 'ORDER', Number(date.slice(0, 4)));
      await t.purchaseOrder.create({
        data: {
          companyId, number, supplierId: suppliers[i % suppliers.length].id, date: fromISO(date), expectedDate: fromISO(addDays(date, 14)), status,
          total: r2(olines.reduce((a, l) => a + l.qty * l.unitCost, 0)), createdBy: actor.name, lines: { create: olines },
        },
      });
    });
  }

  // ---------------------------------------------------------------- troškovi
  const cat = async (name: string) => (await db.expenseCategory.findFirstOrThrow({ where: { companyId, name } })).id;
  await db.expense.createMany({
    data: [
      { companyId, date: fromISO('2025-01-05'), categoryId: await cat('Najam prostora'), description: 'Najam skladišta Zagreb', netAmount: 1200, vatAmount: 300, frequency: 'MONTHLY', paid: true, createdBy: actor.name },
      { companyId, date: fromISO('2025-01-10'), categoryId: await cat('Telekomunikacije'), description: 'Mobilna i fiksna mreža', netAmount: 85, vatAmount: 21.25, frequency: 'MONTHLY', paid: true, createdBy: actor.name },
      { companyId, date: fromISO('2025-02-01'), categoryId: await cat('Softver i licence'), description: 'Microsoft 365 i MDM licence', netAmount: 145, vatAmount: 36.25, frequency: 'MONTHLY', paid: true, createdBy: actor.name },
      { companyId, date: fromISO('2025-01-15'), categoryId: await cat('Knjigovodstvo'), description: 'Knjigovodstveni servis', netAmount: 350, vatAmount: 87.5, frequency: 'MONTHLY', paid: true, createdBy: actor.name },
      { companyId, date: fromISO('2025-03-01'), categoryId: await cat('Marketing'), description: 'Google Ads kampanja', netAmount: 400, vatAmount: 0, frequency: 'QUARTERLY', paid: true, createdBy: actor.name },
      { companyId, date: fromISO(addDays(TODAY, -40)), categoryId: await cat('Gorivo i putni troškovi'), description: 'Gorivo — terenske instalacije', netAmount: 186.4, vatAmount: 46.6, paid: true, createdBy: actor.name },
      { companyId, date: fromISO(addDays(TODAY, -8)), categoryId: await cat('Servis i popravci'), description: 'Zamjena ekrana — vanjski servis', netAmount: 120, vatAmount: 30, paid: false, createdBy: actor.name },
    ],
  });

  const counts = await Promise.all([
    db.item.count({ where: { companyId } }),
    db.invoice.count({ where: { companyId } }),
    db.contract.count({ where: { companyId } }),
  ]);
  console.log(`Demo firma spremna za ${((Date.now() - t0) / 1000).toFixed(1)} s — uređaja ${counts[0]}, računa ${counts[1]}, ugovora ${counts[2]}.`);
  console.log('Prijava: admin@demo.hr / admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
