import 'server-only';
import type { InvoiceKind, InvoiceType, LineKind, PaymentMethod, Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { DomainError, assert } from '../errors';
import { nextSeq } from '../numbering';
import { audit } from '../audit';
import { changeItemStatus, itemEvents, type Actor } from './items';
import { documentTotals, formatInvoiceNumber, lineShareOfNet, openAmount, overpaidAmount, paymentReference, INVOICE_KIND_LABEL, type ChargeInput } from '@/domain/invoice';
import { addDays, formatDate, fromISO, toISO, today } from '@/domain/dates';
import type { BillingCode, PlanPeriodInput } from '@/domain/billing';
import { coveredPeriods, rentPeriodFor } from './contract-items';
import { num, r2 } from '@/domain/money';
import { fiscalAtIssue } from '../fiscal/issue';
import { billingFromMonths, defaultKpd, effectiveLineType, hasRentLines, invoiceRentPlan, kpdIssues, kpdValid } from '@/domain/sales-lines';
import { fiscalRoute } from '@/domain/fiscal';
import { alignInvoiceVat, mixedSupplyError, supplyKindOf } from '@/domain/tax';
import { eur } from '@/lib/format';
import { assertAdvanceNotUsed, checkAdvancesAtIssue, setAdvanceUses, type AdvanceUseInput } from './invoice-advances';

// ---------------------------------------------------------------- ulazni oblici

export interface LineInput {
  kind: LineKind;
  itemId?: string | null;
  modelId?: string | null;
  serviceId?: string | null;
  description: string;
  unit?: string | null;
  kpd?: string | null;
  qty: number;
  unitPrice: number;
  /** Najam: mjesečna cijena i broj mjeseci (unitPrice = monthly × months). */
  monthly?: number | null;
  months?: number | null;
  discountPct?: number | null;
  warrantyMonths?: number | null;
  agreedPrice?: boolean;
  /** Vrsta stavke na miješanom računu (null = vrsta računa). */
  lineType?: 'SALE' | 'RENT' | null;
}

export interface InvoiceInput {
  type: InvoiceType;
  kind?: InvoiceKind;
  partnerId: string;
  date: string;
  dueDate?: string | null;
  deliveryDate?: string | null;
  vatRate: number;
  taxCategory?: string;
  taxExemptReason?: string | null;
  discountPct?: number;
  discountAmount?: number;
  charges?: ChargeInput[];
  /** Uračunati predujmovi (računi za predujam kupca i iznos s PDV-om) — samo konačni račun. */
  advances?: AdvanceUseInput[];
  contractId?: string | null;
  period?: string | null;
  description?: string | null;
  note?: string | null;
  /** Način plaćanja — određuje fiskalizaciju (gotovina/kartica → CIS). */
  paymentMethod?: PaymentMethod;
  /** Najam: „Zatim naplata prelazi u" — od datuma `from` novi uređaji s računa prelaze na naplatu `billing`. */
  rentNext?: { billing: BillingCode; from: string } | null;
  lines: LineInput[];
}

// ---------------------------------------------------------------- zbrojevi

/**
 * Preračun zbrojeva računa iz stavki, uplata i odobrenja. Zove se nakon svake
 * promjene — zbrojevi na zaglavlju su izvor za popise i izvještaje.
 */
export async function recalcInvoice(tx: Tx, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      lines: { orderBy: { sort: 'asc' } },
      payments: { orderBy: { date: 'asc' } },
      corrections: { where: { kind: 'CREDIT_NOTE', status: 'ISSUED' }, select: { grandTotal: true } },
    },
  });
  const t = documentTotals({
    lines: inv.lines.map((l) => ({ qty: num(l.qty), unitPrice: num(l.unitPrice), discountPct: num(l.discountPct) })),
    vatRate: num(inv.vatRate),
    discountPct: num(inv.discountPct),
    discountAmount: num(inv.discountAmount),
    charges: inv.charges as unknown as ChargeInput[],
  });
  for (let i = 0; i < inv.lines.length; i++) {
    if (num(inv.lines[i].netAmount) !== t.lineNets[i]) {
      await tx.invoiceLine.update({ where: { id: inv.lines[i].id }, data: { netAmount: t.lineNets[i] } });
    }
  }
  const paid = r2(inv.payments.reduce((a, p) => a + num(p.amount), 0));
  const credited = r2(inv.corrections.reduce((a, c) => a + Math.abs(num(c.grandTotal)), 0));
  const open = openAmount({ kind: inv.kind, stornoed: inv.stornoed, total: r2(t.total - credited), advance: num(inv.advanceAmount), paid });
  const cost = r2(inv.lines.reduce((a, l) => a + num(l.cost), 0));
  const settled = inv.status === 'ISSUED' && open <= 0.005 && (inv.kind === 'INVOICE' || inv.kind === 'ADVANCE') && !inv.stornoed && t.total > 0;
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      netTotal: t.net,
      vatTotal: t.vat,
      chargesTotal: t.charges,
      grandTotal: t.total,
      paidTotal: paid,
      creditedTotal: credited,
      openAmount: inv.status === 'ISSUED' ? open : 0,
      costTotal: cost,
      paidDate: settled ? (inv.payments.at(-1)?.date ?? inv.date) : null,
    },
  });
  return t;
}

// ---------------------------------------------------------------- nacrt

async function writeLines(tx: Tx, actor: Actor, invoiceId: string, type: InvoiceType, lines: LineInput[]) {
  const itemIds = lines.filter((l) => l.kind === 'DEVICE' && l.itemId).map((l) => l.itemId!);
  assert(new Set(itemIds).size === itemIds.length, 'Isti uređaj je dvaput na računu.');
  const items = itemIds.length
    ? await tx.item.findMany({ where: { id: { in: itemIds }, companyId: actor.companyId }, select: { id: true, cost: true, modelId: true } })
    : [];
  assert(items.length === itemIds.length, 'Neki uređaji na računu ne postoje.');
  const byId = new Map(items.map((i) => [i.id, i]));

  // šifrarnici sa stavki moraju pripadati istoj firmi
  const modelIds = [...new Set([...lines.map((l) => l.modelId), ...items.map((i) => i.modelId)].filter((v): v is string => !!v))];
  const serviceIds = [...new Set(lines.filter((l) => l.kind === 'SERVICE').map((l) => l.serviceId).filter((v): v is string => !!v))];
  const [models, services, company] = await Promise.all([
    modelIds.length ? tx.deviceModel.findMany({ where: { id: { in: modelIds }, companyId: actor.companyId }, select: { id: true, kpd: true, kpdRent: true } }) : [],
    serviceIds.length ? tx.service.findMany({ where: { id: { in: serviceIds }, companyId: actor.companyId }, select: { id: true, kpd: true } }) : [],
    tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { kpdSale: true, kpdRent: true, kpdService: true } }),
  ]);
  assert(models.length === modelIds.length && services.length === serviceIds.length, 'Neki modeli ili usluge na računu ne postoje.');
  const modelById = new Map(models.map((m) => [m.id, m]));
  const serviceById = new Map(services.map((x) => [x.id, x]));

  await tx.invoiceLine.deleteMany({ where: { invoiceId } });
  await tx.invoiceLine.createMany({
    data: lines.map((l, sort) => {
      assert(l.description?.trim(), `Stavka ${sort + 1}: opis je obavezan.`);
      assert(l.qty !== 0, `Stavka ${sort + 1}: količina ne može biti 0.`);
      assert(!l.kpd?.trim() || kpdValid(l.kpd), `Stavka ${sort + 1}: KPD „${l.kpd?.trim()}" nije oblika NN.NN.NN (npr. 26.20.16).`);
      const item = l.itemId ? byId.get(l.itemId) : undefined;
      const months = l.months ?? null;
      const unitPrice = r2(l.unitPrice);
      // najam: cijena sa stavke je mjerodavna — ručno promijenjena cijena preračunava mjesečnu
      let monthly = l.monthly ?? null;
      if (monthly !== null && months && Math.abs(r2(monthly * months) - unitPrice) > 0.005) monthly = r2(unitPrice / months);
      // vrsta stavke se sprema samo kad odstupa od vrste računa (miješani račun)
      const lt = effectiveLineType(l.lineType ?? null, type);
      const lineType = lt === type ? null : lt;
      const modelId = l.modelId ?? item?.modelId ?? null;
      const m = modelId ? modelById.get(modelId) : undefined;
      // zadana KPD šifra (usluga → model → firma po vrsti) kad je korisnik nije upisao
      const kpd =
        l.kpd?.trim() ||
        defaultKpd({
          lineType: lt,
          kind: l.kind,
          serviceKpd: l.serviceId ? serviceById.get(l.serviceId)?.kpd : null,
          modelKpd: m?.kpd,
          modelKpdRent: m?.kpdRent,
          company,
        });
      return {
        invoiceId,
        sort,
        kind: l.kind,
        itemId: l.kind === 'DEVICE' ? (l.itemId ?? null) : null,
        modelId,
        serviceId: l.kind === 'SERVICE' ? (l.serviceId ?? null) : null,
        description: l.description.trim(),
        // najam: količina je broj uređaja, pa je zadana jedinica „kom" (i za mjesečnu naplatu)
        unit: l.unit || 'kom',
        kpd: kpd || null,
        qty: l.qty,
        monthly,
        months,
        unitPrice,
        discountPct: l.discountPct ?? 0,
        // nabavna vrijednost ulazi u maržu samo kod prodaje
        cost: lt === 'SALE' && item ? r2(num(item.cost) * Math.sign(l.qty)) : 0,
        warrantyMonths: l.warrantyMonths ?? null,
        agreedPrice: !!l.agreedPrice,
        lineType,
      };
    }),
  });
}

function headerData(input: InvoiceInput) {
  return {
    type: input.type,
    kind: input.kind ?? 'INVOICE',
    partnerId: input.partnerId,
    date: fromISO(input.date),
    year: Number(input.date.slice(0, 4)),
    dueDate: input.dueDate ? fromISO(input.dueDate) : null,
    deliveryDate: input.deliveryDate ? fromISO(input.deliveryDate) : null,
    // PDV se obračunava samo u kategoriji S (standardna stopa); oslobođenja i prijenos obveze su 0 %
    vatRate: (input.taxCategory ?? 'S') === 'S' ? input.vatRate : 0,
    taxCategory: input.taxCategory ?? 'S',
    taxExemptReason: input.taxExemptReason ?? null,
    discountPct: input.discountPct ?? 0,
    discountAmount: input.discountAmount ?? 0,
    charges: (input.charges ?? []) as unknown as Prisma.InputJsonValue,
    contractId: input.contractId ?? null,
    period: input.period ?? null,
    description: input.description ?? null,
    note: input.note ?? null,
    paymentMethod: input.paymentMethod ?? 'TRANSFER',
    rentNextBilling: input.contractId && input.rentNext ? input.rentNext.billing : null,
    rentNextFrom: input.contractId && input.rentNext ? fromISO(input.rentNext.from) : null,
  } satisfies Partial<Prisma.InvoiceUncheckedCreateInput>;
}

/**
 * Porezni tretman nacrta prema vrsti isporuke (roba / najam i usluge): automatski
 * upisan tretman stranog kupca usklađuje se s vrstom računa (npr. najam kupcu u EU →
 * AE i čl. 17., ne K i čl. 41.), a miješani račun robe i usluge stranom kupcu se
 * odbija — račun ima jednu kategoriju i jedan razlog oslobođenja.
 */
async function vatForDraft(tx: Tx, actor: Actor, partner: { country: string | null; vatCategoryOverride: string | null }, input: InvoiceInput): Promise<InvoiceInput> {
  const company = await tx.company.findUniqueOrThrow({
    where: { id: actor.companyId },
    select: { vatRegistered: true, vatRate: true, country: true, vatTextEuGoods: true, vatTextEuService: true, vatTextThirdGoods: true, vatTextThirdService: true },
  });
  const vc = { ...company, vatRate: num(company.vatRate) };
  const kind = supplyKindOf(input.type, input.lines);
  const taxCategory = input.taxCategory ?? 'S';
  const mixed = mixedSupplyError(partner, vc, taxCategory, kind);
  if (mixed) throw new DomainError(mixed);
  const t = alignInvoiceVat(partner, vc, kind, { taxCategory, taxExemptReason: input.taxExemptReason ?? null });
  return { ...input, taxCategory: t.taxCategory, taxExemptReason: t.taxExemptReason, vatRate: t.taxCategory === 'S' ? input.vatRate : 0 };
}

function checkDraftDates(input: InvoiceInput) {
  if (input.dueDate) assert(input.dueDate >= input.date, `Dospijeće (${formatDate(input.dueDate)}) ne može biti prije datuma računa (${formatDate(input.date)}).`);
}

export async function createDraft(tx: Tx, actor: Actor, input: InvoiceInput) {
  checkDraftDates(input);
  const partner = await tx.partner.findFirst({ where: { id: input.partnerId, companyId: actor.companyId } });
  assert(partner, 'Kupac ne postoji.');
  input = await vatForDraft(tx, actor, partner, input);
  const inv = await tx.invoice.create({
    data: { companyId: actor.companyId, ...headerData(input), createdBy: actor.name },
  });
  await writeLines(tx, actor, inv.id, input.type, input.lines);
  await setAdvanceUses(tx, actor, { id: inv.id, partnerId: input.partnerId, kind: input.kind ?? 'INVOICE' }, input.advances ?? []);
  await recalcInvoice(tx, inv.id);
  await audit(tx, actor, { entity: 'invoice', entityId: inv.id, action: 'create', summary: `Nacrt računa za ${partner.name}` });
  return inv;
}

export async function updateDraft(tx: Tx, actor: Actor, id: string, input: InvoiceInput) {
  const inv = await tx.invoice.findFirst({ where: { id, companyId: actor.companyId } });
  assert(inv, 'Račun ne postoji.');
  assert(inv.status === 'DRAFT', 'Izdani račun se ne može mijenjati — ispravak ide stornom ili odobrenjem.');
  checkDraftDates(input);
  const partner = await tx.partner.findFirst({ where: { id: input.partnerId, companyId: actor.companyId }, select: { id: true, country: true, vatCategoryOverride: true } });
  assert(partner, 'Kupac ne postoji.');
  input = await vatForDraft(tx, actor, partner, input);
  await tx.invoice.update({ where: { id }, data: headerData(input) });
  await writeLines(tx, actor, id, input.type, input.lines);
  await setAdvanceUses(tx, actor, { id, partnerId: input.partnerId, kind: input.kind ?? 'INVOICE' }, input.advances ?? []);
  await recalcInvoice(tx, id);
  await audit(tx, actor, { entity: 'invoice', entityId: id, action: 'update', summary: 'Nacrt računa izmijenjen' });
}

export async function deleteDraft(tx: Tx, actor: Actor, id: string) {
  const inv = await tx.invoice.findFirst({ where: { id, companyId: actor.companyId } });
  assert(inv, 'Račun ne postoji.');
  assert(inv.status === 'DRAFT', 'Izdani račun se ne briše — poništava se stornom.');
  await tx.invoice.delete({ where: { id } });
  // ugovor otvoren iz ovog nacrta („+ Novi ugovor") a još bez uređaja i dokumenata briše se s nacrtom
  if (inv.contractId) await dropEmptyInvoiceContract(tx, actor, inv.contractId);
  await audit(tx, actor, { entity: 'invoice', entityId: id, action: 'delete', summary: 'Nacrt računa obrisan' });
}

/** Oznaka u napomeni ugovora koji je otvoren iz računa (Prodaja → račun za najam → „+ Novi ugovor"). */
export const CONTRACT_FROM_INVOICE = 'Otvoren iz računa';

/** Prazan ugovor otvoren iz nacrta računa (bez uređaja, računa i ponuda) — briše se. */
export async function dropEmptyInvoiceContract(tx: Tx, actor: Actor, contractId: string) {
  const c = await tx.contract.findFirst({
    where: { id: contractId, companyId: actor.companyId, note: { startsWith: CONTRACT_FROM_INVOICE } },
    select: { id: true, number: true, _count: { select: { items: true, returnedItems: true, invoices: true, quotes: true } } },
  });
  if (!c || c._count.items || c._count.returnedItems || c._count.invoices || c._count.quotes) return false;
  await tx.contract.delete({ where: { id: c.id } });
  await audit(tx, actor, { entity: 'contract', entityId: c.id, action: 'delete', summary: `Ugovor ${c.number} obrisan — nacrt računa iz kojeg je otvoren više ga ne koristi` });
  return true;
}

// ---------------------------------------------------------------- izdavanje

/** Izdani dokument (račun, predujam, storno, odobrenje) ne smije imati datum u budućnosti. */
export function assertIssueDate(date: string, now = today()) {
  assert(
    date <= now,
    `Datum ${formatDate(date)} je u budućnosti — račun se izdaje najkasnije s današnjim datumom (${formatDate(now)}). Nacrt može imati budući datum, a izdaje se na dan isporuke.`,
  );
}

/**
 * Izdavanje: dodjela rednog broja u transakciji, provjera da redni broj prati
 * datum, i učinak na uređaje (prodaja skida sa stanja, najam veže uz ugovor).
 */
export async function issueInvoice(tx: Tx, actor: Actor, id: string) {
  // zaključavanje reda sprječava dvostruko izdavanje istog nacrta
  await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
  const inv = await tx.invoice.findFirst({
    where: { id, companyId: actor.companyId },
    include: { lines: { orderBy: { sort: 'asc' } }, partner: true, company: true },
  });
  assert(inv, 'Račun ne postoji.');
  assert(inv.status === 'DRAFT', 'Račun je već izdan.');
  assert(inv.lines.length > 0, 'Račun nema stavki.');
  if (inv.kind === 'INVOICE' || inv.kind === 'ADVANCE') {
    // nacrt spremljen prije provjere: roba i usluga stranom kupcu ne idu na isti račun
    const mixed = mixedSupplyError(inv.partner, { ...inv.company, vatRate: num(inv.company.vatRate) }, inv.taxCategory, supplyKindOf(inv.type, inv.lines));
    if (mixed) throw new DomainError(mixed);
  }

  const date = toISO(inv.date);
  // račun se izdaje na dan isporuke — datum u budućnosti bi zaključao numeraciju do tog dana
  assertIssueDate(date);
  if (inv.dueDate) assert(toISO(inv.dueDate) >= date, `Dospijeće (${formatDate(inv.dueDate)}) ne može biti prije datuma računa (${formatDate(inv.date)}).`);
  const year = inv.date.getUTCFullYear();
  const later = await tx.invoice.findFirst({
    where: { companyId: actor.companyId, status: 'ISSUED', year, date: { gt: inv.date } },
    orderBy: [{ date: 'desc' }, { seq: 'desc' }],
    select: { number: true, date: true, kind: true },
  });
  if (later) {
    throw new DomainError(
      `Zadnji izdani dokument (${INVOICE_KIND_LABEL[later.kind].toLowerCase()} ${later.number}) ima datum ${formatDate(later.date)} — novi račun ne može imati raniji datum jer redni broj mora pratiti datum izdavanja.`,
    );
  }

  // miješani račun: prodajne stavke skidaju uređaje sa stanja, stavke najma vežu uređaje uz ugovor
  if (inv.kind === 'INVOICE') {
    const saleLines = inv.lines.filter((l) => effectiveLineType(l.lineType, inv.type) === 'SALE');
    const rentLines = inv.lines.filter((l) => effectiveLineType(l.lineType, inv.type) === 'RENT');
    if (saleLines.some((l) => l.kind === 'DEVICE' && l.itemId)) await applySale(tx, actor, inv, saleLines);
    if (hasRentLines(inv.type, inv.lines)) await applyRent(tx, actor, inv, rentLines);
  }
  if (inv.kind === 'INVOICE' || inv.kind === 'ADVANCE') {
    assert(inv.lines.every((l) => l.kind !== 'MODEL'), 'Stavke bez serijskog broja treba zamijeniti konkretnim uređajima prije izdavanja.');
  }
  // eRačun (B2B, HR CIUS-2025, HR-BR-25): svaka stavka računa nosi KPD 2025 — bez njega posrednik odbija dokument
  if (inv.kind === 'INVOICE' && fiscalRoute({ paymentMethod: inv.paymentMethod, company: inv.company, partner: inv.partner }) === 'EINVOICE') {
    const issues = kpdIssues(inv.lines);
    if (issues.length) throw new DomainError(`Račun ide kao eRačun, a KPD 2025 nije potpun: ${issues.join(' ')} Upišite šifru na stavci (ili na modelu / usluzi / u postavkama firme).`);
  }

  // uračunati predujmovi: ostatak se provjerava ponovno pod zaključavanjem (istodobni računi)
  if (inv.kind === 'INVOICE') await checkAdvancesAtIssue(tx, actor, inv);

  const seq = await nextSeq(tx, actor.companyId, 'INVOICE', year);
  const number = formatInvoiceNumber(seq, inv.company.invoicePremises, inv.company.invoiceDevice, inv.company.invoiceSeparator);
  const termDays = inv.partner.paymentTermDays ?? inv.company.paymentTermDays;
  // cijele sekunde: isto vrijeme ide u ZKI, u CIS poruku i na ispis
  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  await tx.invoice.update({
    where: { id },
    data: {
      status: 'ISSUED',
      seq,
      number,
      paymentRef: paymentReference(seq, year),
      dueDate: inv.dueDate ?? (inv.kind === 'INVOICE' || inv.kind === 'ADVANCE' ? fromISO(addDays(date, termDays)) : null),
      issuedAt,
      issuedBy: actor.name,
      // preslika postavki firme: ispis i eRačun izdanog računa ne mijenjaju se s kasnijim postavkama
      sellerVatRegistered: inv.company.vatRegistered,
      vatOnPayment: inv.company.vatOnPayment,
    },
  });
  const totals = await recalcInvoice(tx, id);
  // fiskalizacija: ZKI i stanje PENDING; poziv CIS-a/posrednika ide nakon transakcije
  const fiscal = await fiscalAtIssue(tx, actor, { paymentMethod: inv.paymentMethod, company: inv.company, partner: inv.partner, seq, issuedAt, total: totals.total });
  await tx.invoice.update({ where: { id }, data: fiscal });
  await audit(tx, actor, {
    entity: 'invoice',
    entityId: id,
    action: 'issue',
    summary: `${INVOICE_KIND_LABEL[inv.kind]} ${number} izdan za ${inv.partner.name}`,
  });
  // gotovina i kartica se naplaćuju pri izdavanju (račun i račun za predujam) — naplaćuje se
  // otvoreni iznos, tj. ukupno umanjeno za odbijeni predujam
  if ((inv.kind === 'INVOICE' || inv.kind === 'ADVANCE') && (inv.paymentMethod === 'CASH' || inv.paymentMethod === 'CARD') && totals.total > 0) {
    const open = num((await tx.invoice.findUniqueOrThrow({ where: { id }, select: { openAmount: true } })).openAmount);
    if (open > 0.005) {
      await addPayment(tx, actor, id, { date, amount: open, method: inv.paymentMethod === 'CASH' ? 'Gotovina' : 'Kartica', note: 'Naplaćeno pri izdavanju' });
    }
  }
  return { number };
}

type IssuingInvoice = Prisma.InvoiceGetPayload<{ include: { lines: true; partner: true; company: true } }>;

async function applySale(tx: Tx, actor: Actor, inv: IssuingInvoice, saleLines: IssuingInvoice['lines']) {
  const devLines = saleLines.filter((l) => l.kind === 'DEVICE' && l.itemId);
  if (!devLines.length) return;
  const items = await tx.item.findMany({
    where: { id: { in: devLines.map((l) => l.itemId!) } },
    select: { id: true, serial: true, state: true, warrantyMonths: true, contractItem: { select: { id: true } } },
  });
  const bad = items.filter((i) => !['IN_STOCK', 'RESERVED', 'OTHER'].includes(i.state) || i.contractItem);
  if (bad.length) throw new DomainError(`Uređaji nisu raspoloživi za prodaju: ${bad.map((i) => i.serial).join(', ')}`);

  const totals = documentTotals({
    lines: inv.lines.map((l) => ({ qty: num(l.qty), unitPrice: num(l.unitPrice), discountPct: num(l.discountPct) })),
    vatRate: num(inv.vatRate),
    discountPct: num(inv.discountPct),
    discountAmount: num(inv.discountAmount),
  });
  const date = inv.date;
  const byItem = new Map(items.map((i) => [i.id, i]));
  // status i veze skupno, a prodajna cijena i jamstvo po uređaju
  await changeItemStatus(tx, actor, devLines.map((l) => l.itemId!), {
    kind: 'SOLD',
    data: { partnerId: inv.partnerId, invoiceId: inv.id, issueDate: date, warrantyStart: date, warehouseId: null },
    event: { type: 'SOLD', message: `Prodan — račun (${inv.partner.name})`, refType: 'invoice', refId: inv.id },
  });
  for (const l of devLines) {
    const idx = inv.lines.indexOf(l);
    await tx.item.update({
      where: { id: l.itemId! },
      data: {
        salePrice: lineShareOfNet(totals, idx),
        warrantyMonths: l.warrantyMonths ?? byItem.get(l.itemId!)?.warrantyMonths ?? inv.company.defaultWarrantyMonths,
      },
    });
  }
}

/**
 * Stavke najma: uređaji koji još nisu na ugovoru računa (račun za najam iz
 * Prodaje — postojeći ugovor ili „+ Novi ugovor") vežu se uz ugovor s mjesečnom
 * cijenom sa stavke; naplata tih uređaja kreće od datuma računa. Razdoblje koje
 * račun pokriva je prva još nefakturirana rata tih uređaja (ili mjesec računa).
 */
async function applyRent(tx: Tx, actor: Actor, inv: IssuingInvoice, rentLines: IssuingInvoice['lines']) {
  assert(inv.contractId, 'Stavke najma moraju biti vezane uz ugovor — odaberite ugovor ili „+ Novi ugovor".');
  // zaključavanje ugovora: dva istodobna računa (ili račun i rata iz Najma) ne fakturiraju isto razdoblje
  await tx.$queryRaw`SELECT id FROM "Contract" WHERE id = ${inv.contractId} FOR UPDATE`;
  const contract = await tx.contract.findFirst({ where: { id: inv.contractId, companyId: actor.companyId } });
  assert(contract, 'Ugovor ne postoji.');
  assert(contract.partnerId === inv.partnerId, 'Ugovor pripada drugom klijentu.');
  const devLines = rentLines.filter((l) => l.kind === 'DEVICE' && l.itemId);
  const ids = devLines.map((l) => l.itemId!);
  const [onContract, returned] = await Promise.all([
    tx.contractItem.findMany({ where: { contractId: inv.contractId, itemId: { in: ids } }, select: { itemId: true } }),
    // skinuti s ugovora: zaostale rate do datuma skidanja
    tx.returnedContractItem.findMany({ where: { contractId: inv.contractId, itemId: { in: ids } }, select: { itemId: true } }),
  ]);
  const current = new Set(onContract.map((c) => c.itemId));
  const known = new Set([...current, ...returned.map((c) => c.itemId)]);
  const attach = devLines.filter((l) => !known.has(l.itemId!));
  const date = toISO(inv.date);
  if (attach.length) {
    // jednokratna naplata pokriva cijeli ugovor — stavka s mjesecima bi uređaju dala mjesečnu naplatu
    assert(contract.billing !== 'ONCE', `Ugovor ${contract.number} ima jednokratnu naplatu — nove uređaje na njega dodajte u modulu Najam.`);
    // dinamički uvoz: rentals.ts uvozi ovaj modul (izbjegava kružni uvoz pri učitavanju)
    const { attachItems } = await import('./rentals');
    const start = toISO(contract.startDate);
    const next = inv.rentNextBilling && inv.rentNextFrom ? { billing: inv.rentNextBilling, from: toISO(inv.rentNextFrom) } : null;
    await attachItems(
      tx,
      actor,
      contract.id,
      attach.map((l) => {
        const months = Math.max(1, l.months ?? 1);
        const monthly = l.monthly !== null ? num(l.monthly) : r2(num(l.unitPrice) / months);
        // uvjeti ugovora vrijede kad se poklapaju; inače uređaj dobiva vlastiti plan od datuma računa
        // (po želji s prijelazom na drugu naplatu od zadanog datuma)
        const plan: PlanPeriodInput[] = invoiceRentPlan({
          invoiceDate: date,
          contractStart: start,
          contractBilling: contract.billing,
          lineBilling: l.months ? billingFromMonths(l.months) : contract.billing,
          next,
        });
        return { itemId: l.itemId!, monthly, plan };
      }),
      { issueDate: date },
    );
    for (const l of attach) current.add(l.itemId!);
    await audit(tx, actor, {
      entity: 'contract',
      entityId: contract.id,
      action: 'add',
      summary: `Ugovor ${contract.number}: dodano ${attach.length} uređaja računom za najam`,
    });
  }
  const period = await rentPeriodFor(tx, contract.id, devLines, inv.period, date);
  if (period !== inv.period) {
    await tx.invoice.update({ where: { id: inv.id }, data: { period } });
    inv.period = period;
  }
  if (devLines.length) {
    // veza na zadnji račun samo za uređaje koji su još na ugovoru (vraćeni su možda već na skladištu ili kod drugog kupca)
    if (current.size) await tx.item.updateMany({ where: { id: { in: [...current] } }, data: { invoiceId: inv.id } });
    await itemEvents(tx, actor, ids, {
      type: 'RENT_INVOICE',
      message: `Rata najma ${inv.period} fakturirana`,
      refType: 'invoice',
      refId: inv.id,
    });
  }
}

/**
 * Datum ispravka: traženi (ili danas), ali ne raniji od zadnjeg izdanog računa
 * u toj godini — redni broj prati datum, pa se datum pomiče umjesto da izdavanje padne.
 */
async function correctionDate(tx: Tx, companyId: string, requested?: string) {
  const t = requested || today();
  assertIssueDate(t);
  const last = await tx.invoice.findFirst({
    where: { companyId, status: 'ISSUED', year: Number(t.slice(0, 4)) },
    orderBy: { date: 'desc' },
    select: { date: true },
  });
  return last && toISO(last.date) > t ? toISO(last.date) : t;
}

// ---------------------------------------------------------------- storno i odobrenje

/** Storno poništava cijeli račun: novi dokument s negativnim stavkama. */
export async function stornoInvoice(tx: Tx, actor: Actor, id: string, opts: { date?: string; reason?: string } = {}) {
  // zaključavanje izvornog računa: dva istovremena storna (ili storno i odobrenje) ne prolaze oba
  await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
  const inv = await tx.invoice.findFirst({ where: { id, companyId: actor.companyId }, include: { lines: { orderBy: { sort: 'asc' } } } });
  assert(inv, 'Račun ne postoji.');
  assert(inv.status === 'ISSUED', 'Nacrt se ne stornira — obrišite ga.');
  assert(inv.kind === 'INVOICE' || inv.kind === 'ADVANCE', 'Storno i odobrenje se ne storniraju.');
  assert(!inv.stornoed, 'Račun je već storniran.');
  if (inv.kind === 'ADVANCE') await assertAdvanceNotUsed(tx, inv.id);
  // gotovina/kartica su naplaćene pri izdavanju — storno je ujedno povrat novca kupcu
  const paidOnIssue = inv.paymentMethod === 'CASH' || inv.paymentMethod === 'CARD';
  assert(paidOnIssue || num(inv.paidTotal) === 0, 'Račun ima uplate — prvo ih uklonite ili izdajte odobrenje.');
  assert(num(inv.creditedTotal) === 0, 'Na račun su izdana odobrenja — ostatak iznosa ispravite novim odobrenjem umjesto stornom.');

  const date = await correctionDate(tx, actor.companyId, opts.date);
  const storno = await tx.invoice.create({
    data: {
      companyId: actor.companyId,
      kind: 'STORNO',
      type: inv.type,
      partnerId: inv.partnerId,
      date: fromISO(date),
      year: Number(date.slice(0, 4)),
      vatRate: inv.vatRate,
      taxCategory: inv.taxCategory,
      taxExemptReason: inv.taxExemptReason,
      discountPct: inv.discountPct,
      discountAmount: inv.discountAmount,
      charges: inv.charges as Prisma.InputJsonValue,
      refInvoiceId: inv.id,
      paymentMethod: inv.paymentMethod,
      contractId: inv.contractId,
      period: inv.period,
      description: `Storno računa ${inv.number}${opts.reason ? ` — ${opts.reason}` : ''}`,
      createdBy: actor.name,
      lines: {
        create: inv.lines.map((l) => ({
          sort: l.sort,
          kind: l.kind === 'DEVICE' ? 'MANUAL' : l.kind,
          modelId: l.modelId,
          serviceId: l.serviceId,
          description: l.description,
          unit: l.unit,
          kpd: l.kpd,
          qty: num(l.qty) * -1,
          monthly: l.monthly,
          months: l.months,
          unitPrice: l.unitPrice,
          discountPct: l.discountPct,
          cost: num(l.cost) * -1,
          lineType: l.lineType,
        })),
      },
    },
  });
  await tx.invoice.update({ where: { id: inv.id }, data: { stornoed: true } });
  await issueInvoice(tx, actor, storno.id);
  await recalcInvoice(tx, inv.id);

  // prodana roba koja je još kod kupca vraća se na skladište (i s miješanog računa)
  {
    const sold = await tx.item.findMany({ where: { invoiceId: inv.id, state: 'SOLD' }, select: { id: true, receipt: { select: { warehouseId: true } } } });
    if (sold.length) {
      // vraća se u skladište iz kojeg je zaprimljen, a ako ga nema — u prvo aktivno
      const fallback = await tx.warehouse.findFirst({ where: { companyId: actor.companyId, active: true }, orderBy: [{ sort: 'asc' }, { name: 'asc' }], select: { id: true } });
      const groups = new Map<string | null, string[]>();
      for (const i of sold) {
        const w = i.receipt?.warehouseId ?? fallback?.id ?? null;
        groups.set(w, [...(groups.get(w) ?? []), i.id]);
      }
      for (const [warehouseId, ids] of groups) {
        await changeItemStatus(tx, actor, ids, {
          kind: 'IN_STOCK',
          data: { warehouseId },
          event: { type: 'RETURNED', message: `Vraćen na skladište — storno računa ${inv.number}`, refType: 'invoice', refId: storno.id },
        });
      }
    }
  }
  return storno;
}

/** Knjižno odobrenje — umanjuje dio iznosa izvornog računa. */
export async function creditNote(
  tx: Tx,
  actor: Actor,
  id: string,
  input: { date?: string; description: string; netAmount: number },
) {
  // zaključavanje izvornog računa: istovremena odobrenja ne smiju zajedno premašiti iznos računa
  await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
  const inv = await tx.invoice.findFirst({ where: { id, companyId: actor.companyId }, include: { lines: { select: { kpd: true } } } });
  assert(inv, 'Račun ne postoji.');
  assert(inv.status === 'ISSUED' && inv.kind === 'INVOICE' && !inv.stornoed, 'Odobrenje se izdaje samo na važeći izdani račun.');
  // KPD izvornih stavki: kad su sve iste, stavka odobrenja nosi istu šifru (u UBL-u odobrenje ide bez KPD-a — P9)
  const kpds = [...new Set(inv.lines.map((l) => l.kpd ?? ''))];
  const kpd = kpds.length === 1 && kpds[0] ? kpds[0] : null;
  assert(input.netAmount > 0, 'Iznos odobrenja mora biti veći od 0.');
  const maxNet = r2(num(inv.netTotal) - num(inv.creditedTotal) / (1 + num(inv.vatRate) / 100));
  assert(input.netAmount <= maxNet + 0.005, 'Odobrenje ne može biti veće od iznosa računa.');
  const date = await correctionDate(tx, actor.companyId, input.date);
  const note = await tx.invoice.create({
    data: {
      companyId: actor.companyId,
      kind: 'CREDIT_NOTE',
      type: inv.type,
      partnerId: inv.partnerId,
      date: fromISO(date),
      year: Number(date.slice(0, 4)),
      vatRate: inv.vatRate,
      taxCategory: inv.taxCategory,
      taxExemptReason: inv.taxExemptReason,
      refInvoiceId: inv.id,
      paymentMethod: inv.paymentMethod,
      description: `Odobrenje po računu ${inv.number}`,
      createdBy: actor.name,
      lines: { create: [{ sort: 0, kind: 'MANUAL', description: input.description, kpd, qty: -1, unitPrice: input.netAmount }] },
    },
  });
  await issueInvoice(tx, actor, note.id);
  await recalcInvoice(tx, inv.id);
  return note;
}

// ---------------------------------------------------------------- uplate

export async function addPayment(tx: Tx, actor: Actor, invoiceId: string, p: { date: string; amount: number; method?: string | null; note?: string | null }) {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, companyId: actor.companyId } });
  assert(inv, 'Račun ne postoji.');
  assert(inv.status === 'ISSUED', 'Uplata se evidentira tek na izdanom računu.');
  assert(inv.kind === 'INVOICE' || inv.kind === 'ADVANCE', 'Storno i odobrenje nemaju uplata.');
  assert(!inv.stornoed, 'Račun je storniran.');
  assert(p.amount > 0, 'Iznos uplate mora biti veći od 0.');
  assert(p.amount <= num(inv.openAmount) + 0.005, `Uplata je veća od otvorenog iznosa (${eur(num(inv.openAmount))}).`);
  await tx.payment.create({
    data: { invoiceId, date: fromISO(p.date), amount: r2(p.amount), method: p.method ?? null, note: p.note ?? null, createdBy: actor.name },
  });
  await recalcInvoice(tx, invoiceId);
  await audit(tx, actor, { entity: 'invoice', entityId: invoiceId, action: 'payment', summary: `Uplata ${r2(p.amount).toFixed(2)} na račun ${inv.number}` });
}

/**
 * Povrat kupcu (preplata, npr. odobrenje na plaćeni račun): isplata se upisuje kao
 * negativna uplata, najviše do iznosa preplate.
 */
export async function refundPayment(tx: Tx, actor: Actor, invoiceId: string, p: { date: string; amount: number; method?: string | null; note?: string | null }) {
  await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, companyId: actor.companyId } });
  assert(inv, 'Račun ne postoji.');
  assert(inv.status === 'ISSUED' && (inv.kind === 'INVOICE' || inv.kind === 'ADVANCE'), 'Povrat se evidentira samo na izdanom računu.');
  const over = overpaidAmount({ kind: inv.kind, stornoed: inv.stornoed, total: num(inv.grandTotal), advance: num(inv.advanceAmount), paid: num(inv.paidTotal), credited: num(inv.creditedTotal) });
  assert(over > 0.005, 'Račun nema preplate — nema iznosa za povrat kupcu.');
  assert(p.amount > 0, 'Iznos povrata mora biti veći od 0.');
  assert(p.amount <= over + 0.005, `Povrat je veći od preplate (${eur(over)}).`);
  await tx.payment.create({
    data: { invoiceId, date: fromISO(p.date), amount: -r2(p.amount), method: p.method ?? null, note: p.note || 'Povrat kupcu', createdBy: actor.name },
  });
  await recalcInvoice(tx, invoiceId);
  await audit(tx, actor, { entity: 'invoice', entityId: invoiceId, action: 'refund', summary: `Povrat kupcu ${eur(r2(p.amount))} po računu ${inv.number}` });
}

/** Plaćeno u cijelosti — upisuje uplatu otvorenog iznosa. */
export async function markPaid(tx: Tx, actor: Actor, invoiceId: string, date?: string) {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, companyId: actor.companyId } });
  assert(inv, 'Račun ne postoji.');
  const open = num(inv.openAmount);
  if (open <= 0) return;
  const t = today();
  await addPayment(tx, actor, invoiceId, { date: date ?? (toISO(inv.date) > t ? toISO(inv.date) : t), amount: open, note: 'Plaćeno u cijelosti' });
}

export async function deletePayment(tx: Tx, actor: Actor, paymentId: string) {
  const p = await tx.payment.findFirst({ where: { id: paymentId, invoice: { companyId: actor.companyId } }, include: { invoice: true } });
  assert(p, 'Uplata ne postoji.');
  await tx.payment.delete({ where: { id: paymentId } });
  await recalcInvoice(tx, p.invoiceId);
  await audit(tx, actor, { entity: 'invoice', entityId: p.invoiceId, action: 'payment-delete', summary: `Obrisana uplata ${num(p.amount).toFixed(2)} s računa ${p.invoice.number}` });
}

export async function markUnpaid(tx: Tx, actor: Actor, invoiceId: string) {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, companyId: actor.companyId } });
  assert(inv, 'Račun ne postoji.');
  await tx.payment.deleteMany({ where: { invoiceId } });
  await recalcInvoice(tx, invoiceId);
  await audit(tx, actor, { entity: 'invoice', entityId: invoiceId, action: 'unpaid', summary: `Račun ${inv.number} vraćen u neplaćeno` });
}

// ---------------------------------------------------------------- najam: pokrivenost

export { coveredPeriods };
