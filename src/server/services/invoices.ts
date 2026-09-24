import 'server-only';
import type { InvoiceKind, InvoiceType, LineKind, PaymentMethod, Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { DomainError, assert } from '../errors';
import { nextSeq } from '../numbering';
import { audit } from '../audit';
import { changeItemStatus, itemEvents, type Actor } from './items';
import { documentTotals, formatInvoiceNumber, lineShareOfNet, openAmount, paymentReference, INVOICE_KIND_LABEL, type ChargeInput } from '@/domain/invoice';
import { addDays, formatDate, fromISO, toISO, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { fiscalAtIssue } from '../fiscal/issue';

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
  advanceAmount?: number;
  contractId?: string | null;
  period?: string | null;
  description?: string | null;
  note?: string | null;
  /** Način plaćanja — određuje fiskalizaciju (gotovina/kartica → CIS). */
  paymentMethod?: PaymentMethod;
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
  const modelIds = [...new Set(lines.map((l) => l.modelId).filter((v): v is string => !!v))];
  const serviceIds = [...new Set(lines.filter((l) => l.kind === 'SERVICE').map((l) => l.serviceId).filter((v): v is string => !!v))];
  const [models, services] = await Promise.all([
    modelIds.length ? tx.deviceModel.count({ where: { id: { in: modelIds }, companyId: actor.companyId } }) : 0,
    serviceIds.length ? tx.service.count({ where: { id: { in: serviceIds }, companyId: actor.companyId } }) : 0,
  ]);
  assert(models === modelIds.length && services === serviceIds.length, 'Neki modeli ili usluge na računu ne postoje.');

  await tx.invoiceLine.deleteMany({ where: { invoiceId } });
  await tx.invoiceLine.createMany({
    data: lines.map((l, sort) => {
      assert(l.description?.trim(), `Stavka ${sort + 1}: opis je obavezan.`);
      assert(l.qty !== 0, `Stavka ${sort + 1}: količina ne može biti 0.`);
      const item = l.itemId ? byId.get(l.itemId) : undefined;
      const months = l.months ?? null;
      const unitPrice = r2(l.unitPrice);
      // najam: cijena sa stavke je mjerodavna — ručno promijenjena cijena preračunava mjesečnu
      let monthly = l.monthly ?? null;
      if (monthly !== null && months && Math.abs(r2(monthly * months) - unitPrice) > 0.005) monthly = r2(unitPrice / months);
      return {
        invoiceId,
        sort,
        kind: l.kind,
        itemId: l.kind === 'DEVICE' ? (l.itemId ?? null) : null,
        modelId: l.modelId ?? item?.modelId ?? null,
        serviceId: l.kind === 'SERVICE' ? (l.serviceId ?? null) : null,
        description: l.description.trim(),
        unit: l.unit || (monthly !== null ? 'mj' : 'kom'),
        kpd: l.kpd || null,
        qty: l.qty,
        monthly,
        months,
        unitPrice,
        discountPct: l.discountPct ?? 0,
        // nabavna vrijednost ulazi u maržu samo kod prodaje
        cost: type === 'SALE' && item ? r2(num(item.cost) * Math.sign(l.qty)) : 0,
        warrantyMonths: l.warrantyMonths ?? null,
        agreedPrice: !!l.agreedPrice,
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
    advanceAmount: input.advanceAmount ?? 0,
    contractId: input.contractId ?? null,
    period: input.period ?? null,
    description: input.description ?? null,
    note: input.note ?? null,
    paymentMethod: input.paymentMethod ?? 'TRANSFER',
  } satisfies Partial<Prisma.InvoiceUncheckedCreateInput>;
}

export async function createDraft(tx: Tx, actor: Actor, input: InvoiceInput) {
  const partner = await tx.partner.findFirst({ where: { id: input.partnerId, companyId: actor.companyId } });
  assert(partner, 'Kupac ne postoji.');
  const inv = await tx.invoice.create({
    data: { companyId: actor.companyId, ...headerData(input), createdBy: actor.name },
  });
  await writeLines(tx, actor, inv.id, input.type, input.lines);
  await recalcInvoice(tx, inv.id);
  await audit(tx, actor, { entity: 'invoice', entityId: inv.id, action: 'create', summary: `Nacrt računa za ${partner.name}` });
  return inv;
}

export async function updateDraft(tx: Tx, actor: Actor, id: string, input: InvoiceInput) {
  const inv = await tx.invoice.findFirst({ where: { id, companyId: actor.companyId } });
  assert(inv, 'Račun ne postoji.');
  assert(inv.status === 'DRAFT', 'Izdani račun se ne može mijenjati — ispravak ide stornom ili odobrenjem.');
  const partner = await tx.partner.findFirst({ where: { id: input.partnerId, companyId: actor.companyId }, select: { id: true } });
  assert(partner, 'Kupac ne postoji.');
  await tx.invoice.update({ where: { id }, data: headerData(input) });
  await writeLines(tx, actor, id, input.type, input.lines);
  await recalcInvoice(tx, id);
  await audit(tx, actor, { entity: 'invoice', entityId: id, action: 'update', summary: 'Nacrt računa izmijenjen' });
}

export async function deleteDraft(tx: Tx, actor: Actor, id: string) {
  const inv = await tx.invoice.findFirst({ where: { id, companyId: actor.companyId } });
  assert(inv, 'Račun ne postoji.');
  assert(inv.status === 'DRAFT', 'Izdani račun se ne briše — poništava se stornom.');
  await tx.invoice.delete({ where: { id } });
  await audit(tx, actor, { entity: 'invoice', entityId: id, action: 'delete', summary: 'Nacrt računa obrisan' });
}

// ---------------------------------------------------------------- izdavanje

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

  const date = toISO(inv.date);
  const year = inv.date.getUTCFullYear();
  const later = await tx.invoice.findFirst({
    where: { companyId: actor.companyId, status: 'ISSUED', year, date: { gt: inv.date } },
    orderBy: { date: 'desc' },
    select: { number: true, date: true },
  });
  if (later) {
    throw new DomainError(
      `Račun ${later.number} izdan je ${formatDate(later.date)} — novi račun ne može imati raniji datum jer redni broj mora pratiti datum izdavanja.`,
    );
  }

  if (inv.type === 'SALE' && inv.kind === 'INVOICE') await applySale(tx, actor, inv);
  if (inv.type === 'RENT' && inv.kind === 'INVOICE') await applyRent(tx, actor, inv);
  if (inv.kind === 'INVOICE' || inv.kind === 'ADVANCE') {
    assert(inv.lines.every((l) => l.kind !== 'MODEL'), 'Stavke bez serijskog broja treba zamijeniti konkretnim uređajima prije izdavanja.');
  }

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

async function applySale(tx: Tx, actor: Actor, inv: IssuingInvoice) {
  const devLines = inv.lines.filter((l) => l.kind === 'DEVICE' && l.itemId);
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

async function applyRent(tx: Tx, actor: Actor, inv: IssuingInvoice) {
  assert(inv.contractId, 'Račun za najam mora biti vezan uz ugovor.');
  assert(inv.period, 'Račun za najam mora imati razdoblje (mjesec) koje pokriva.');
  const devLines = inv.lines.filter((l) => l.kind === 'DEVICE' && l.itemId);
  const ids = devLines.map((l) => l.itemId!);
  const [onContract, returned] = await Promise.all([
    tx.contractItem.findMany({ where: { contractId: inv.contractId, itemId: { in: ids } }, select: { itemId: true } }),
    // skinuti s ugovora: zaostale rate do datuma skidanja
    tx.returnedContractItem.findMany({ where: { contractId: inv.contractId, itemId: { in: ids } }, select: { itemId: true } }),
  ]);
  const current = new Set(onContract.map((c) => c.itemId));
  const set = new Set([...current, ...returned.map((c) => c.itemId)]);
  const missing = devLines.filter((l) => !set.has(l.itemId!));
  if (missing.length) throw new DomainError('Svi uređaji na računu za najam moraju biti na ugovoru.');
  if (devLines.length) {
    // veza na zadnji račun samo za uređaje koji su još na ugovoru (vraćeni su možda već na skladištu ili kod drugog kupca)
    if (current.size) await tx.item.updateMany({ where: { id: { in: [...current] } }, data: { invoiceId: inv.id } });
    await itemEvents(tx, actor, devLines.map((l) => l.itemId!), {
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
        })),
      },
    },
  });
  await tx.invoice.update({ where: { id: inv.id }, data: { stornoed: true } });
  await issueInvoice(tx, actor, storno.id);
  await recalcInvoice(tx, inv.id);

  // prodana roba koja je još kod kupca vraća se na skladište
  if (inv.type === 'SALE') {
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
  const inv = await tx.invoice.findFirst({ where: { id, companyId: actor.companyId } });
  assert(inv, 'Račun ne postoji.');
  assert(inv.status === 'ISSUED' && inv.kind === 'INVOICE' && !inv.stornoed, 'Odobrenje se izdaje samo na važeći izdani račun.');
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
      lines: { create: [{ sort: 0, kind: 'MANUAL', description: input.description, qty: -1, unitPrice: input.netAmount }] },
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
  assert(p.amount <= num(inv.openAmount) + 0.005, `Uplata je veća od otvorenog iznosa (${num(inv.openAmount).toFixed(2)}).`);
  await tx.payment.create({
    data: { invoiceId, date: fromISO(p.date), amount: r2(p.amount), method: p.method ?? null, note: p.note ?? null, createdBy: actor.name },
  });
  await recalcInvoice(tx, invoiceId);
  await audit(tx, actor, { entity: 'invoice', entityId: invoiceId, action: 'payment', summary: `Uplata ${r2(p.amount).toFixed(2)} na račun ${inv.number}` });
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

export { coveredPeriods } from './contract-items';
