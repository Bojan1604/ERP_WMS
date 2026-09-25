import 'server-only';
import type { LineKind, QuoteKind, QuoteStatus } from '@prisma/client';
import type { Tx } from '../db';
import { assert } from '../errors';
import { audit } from '../audit';
import { nextDocNumber } from '../numbering';
import { createDraft, type LineInput } from './invoices';
import type { Actor } from './items';
import { documentTotals } from '@/domain/invoice';
import { customerVat } from '@/domain/tax';
import { addDays, addMonths, fromISO, today } from '@/domain/dates';
import type { BillingCode } from '@/domain/billing';
import { attachItems, createContract } from './rentals';
import { num, r2 } from '@/domain/money';

export interface QuoteLineInput {
  kind: LineKind;
  itemId?: string | null;
  modelId?: string | null;
  serviceId?: string | null;
  description: string;
  unit?: string | null;
  qty: number;
  unitPrice: number;
  discountPct?: number | null;
  /** Prodaja (zadano) ili najam — kod najma je cijena mjesečna. */
  lineType?: 'SALE' | 'RENT' | null;
}

export interface QuoteInput {
  /** Samo pri izradi: ponuda (zadano) ili predračun — vrsta se poslije ne mijenja. */
  kind?: QuoteKind;
  partnerId: string;
  date: string;
  validUntil?: string | null;
  vatRate: number;
  discountPct?: number;
  discountAmount?: number;
  hideSerials?: boolean;
  note?: string | null;
  lines: QuoteLineInput[];
}

export const QUOTE_KIND_LABEL: Record<QuoteKind, string> = { QUOTE: 'Ponuda', PROFORMA: 'Predračun' };

export const QUOTE_STATUS_LABEL: Record<QuoteStatus | 'EXPIRED', string> = {
  DRAFT: 'Nacrt',
  SENT: 'Poslana',
  ACCEPTED: 'Prihvaćena',
  REJECTED: 'Odbijena',
  EXPIRED: 'Istekla',
};

/** Provjera stavki: veze na uređaje, modele i usluge moraju pripadati firmi. */
async function checkLines(tx: Tx, actor: Actor, lines: QuoteLineInput[]) {
  assert(lines.length > 0, 'Ponuda nema stavki.');
  lines.forEach((l, i) => {
    assert(l.description?.trim(), `Stavka ${i + 1}: opis je obavezan.`);
    assert(l.qty > 0, `Stavka ${i + 1}: količina mora biti veća od 0.`);
    if (l.kind === 'MODEL') assert(l.modelId, `Stavka ${i + 1}: odaberite model.`);
    if (l.kind === 'DEVICE') assert(l.itemId, `Stavka ${i + 1}: odaberite uređaj.`);
    if (l.kind === 'MODEL') assert(Number.isInteger(l.qty), `Stavka ${i + 1}: količina uređaja mora biti cijeli broj.`);
  });
  const itemIds = lines.filter((l) => l.kind === 'DEVICE').map((l) => l.itemId!);
  assert(new Set(itemIds).size === itemIds.length, 'Isti uređaj je dvaput na ponudi.');
  const modelIds = [...new Set(lines.map((l) => l.modelId).filter((x): x is string => !!x))];
  const serviceIds = [...new Set(lines.map((l) => l.serviceId).filter((x): x is string => !!x))];
  const [items, models, services] = await Promise.all([
    itemIds.length ? tx.item.count({ where: { id: { in: itemIds }, companyId: actor.companyId } }) : 0,
    modelIds.length ? tx.deviceModel.count({ where: { id: { in: modelIds }, companyId: actor.companyId } }) : 0,
    serviceIds.length ? tx.service.count({ where: { id: { in: serviceIds }, companyId: actor.companyId } }) : 0,
  ]);
  assert(items === itemIds.length, 'Neki uređaji na ponudi ne postoje.');
  assert(models === modelIds.length, 'Neki modeli na ponudi ne postoje.');
  assert(services === serviceIds.length, 'Neke usluge na ponudi ne postoje.');
}

function totalsOf(input: QuoteInput) {
  return documentTotals({
    lines: input.lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct ?? 0 })),
    vatRate: input.vatRate,
    discountPct: input.discountPct ?? 0,
    discountAmount: input.discountAmount ?? 0,
  });
}

function lineRows(input: QuoteInput, lineNets: number[]) {
  return input.lines.map((l, sort) => ({
    sort,
    kind: l.kind,
    itemId: l.kind === 'DEVICE' ? (l.itemId ?? null) : null,
    modelId: l.kind === 'MODEL' || l.kind === 'DEVICE' ? (l.modelId ?? null) : null,
    serviceId: l.kind === 'SERVICE' ? (l.serviceId ?? null) : null,
    description: l.description.trim(),
    unit: l.unit || 'kom',
    qty: l.qty,
    unitPrice: l.unitPrice,
    discountPct: l.discountPct ?? 0,
    netAmount: lineNets[sort],
    // najam: jedinična cijena je mjesečni najam
    lineType: l.lineType === 'RENT' ? ('RENT' as const) : null,
    monthly: l.lineType === 'RENT' ? l.unitPrice : null,
  }));
}

/** Nova ponuda (id = null) ili izmjena postojeće. Zbrojevi se spremaju na zaglavlje. */
export async function saveQuote(tx: Tx, actor: Actor, id: string | null, input: QuoteInput) {
  const partner = await tx.partner.findFirst({ where: { id: input.partnerId, companyId: actor.companyId }, select: { name: true } });
  assert(partner, 'Kupac ne postoji.');
  await checkLines(tx, actor, input.lines);
  const t = totalsOf(input);
  const header = {
    partnerId: input.partnerId,
    date: fromISO(input.date),
    validUntil: input.validUntil ? fromISO(input.validUntil) : null,
    vatRate: input.vatRate,
    discountPct: input.discountPct ?? 0,
    discountAmount: input.discountAmount ?? 0,
    hideSerials: !!input.hideSerials,
    note: input.note ?? null,
    netTotal: t.net,
    vatTotal: t.vat,
    grandTotal: t.total,
  };
  if (!id) {
    const kind = input.kind ?? 'QUOTE';
    // predračun ima vlastiti brojač (PRED-…), ponuda svoj (PON-…)
    const number = await nextDocNumber(tx, actor.companyId, kind === 'PROFORMA' ? 'PROFORMA' : 'QUOTE', Number(input.date.slice(0, 4)));
    const q = await tx.quote.create({
      data: { companyId: actor.companyId, kind, number, ...header, createdBy: actor.name, lines: { create: lineRows(input, t.lineNets) } },
    });
    await audit(tx, actor, { entity: 'quote', entityId: q.id, action: 'create', summary: `${QUOTE_KIND_LABEL[kind]} ${number} za ${partner.name}` });
    return q;
  }
  const q = await tx.quote.findFirst({ where: { id, companyId: actor.companyId } });
  assert(q, 'Ponuda ne postoji.');
  assert(!q.invoiceId, 'Ponuda je pretvorena u račun i više se ne mijenja.');
  assert(!q.contractId, 'Ponuda je pretvorena u ugovor i više se ne mijenja.');
  await tx.quoteLine.deleteMany({ where: { quoteId: id } });
  const out = await tx.quote.update({ where: { id }, data: { ...header, lines: { create: lineRows(input, t.lineNets) } } });
  await audit(tx, actor, { entity: 'quote', entityId: id, action: 'update', summary: `Ponuda ${q.number} izmijenjena` });
  return out;
}

export async function setQuoteStatus(tx: Tx, actor: Actor, id: string, status: QuoteStatus) {
  const q = await tx.quote.findFirst({ where: { id, companyId: actor.companyId } });
  assert(q, 'Ponuda ne postoji.');
  assert(!q.invoiceId || status === 'ACCEPTED', 'Ponuda je pretvorena u račun.');
  await tx.quote.update({ where: { id }, data: { status } });
  await audit(tx, actor, { entity: 'quote', entityId: id, action: 'status', summary: `Ponuda ${q.number}: ${QUOTE_STATUS_LABEL[status]}` });
}

export async function deleteQuote(tx: Tx, actor: Actor, id: string) {
  const q = await tx.quote.findFirst({ where: { id, companyId: actor.companyId } });
  assert(q, 'Ponuda ne postoji.');
  assert(!q.invoiceId, 'Ponuda je pretvorena u račun i ne može se obrisati.');
  assert(!q.contractId, 'Ponuda je pretvorena u ugovor i ne može se obrisati.');
  await tx.quote.delete({ where: { id } });
  await audit(tx, actor, { entity: 'quote', entityId: id, action: 'delete', summary: `Ponuda ${q.number} obrisana` });
}

/** Uređaji za stavke po modelu: točno `qty` odabranih uređaja tog modela. */
function pickedFor(l: { id: string; qty: unknown; description: string }, picks: Record<string, string[]>) {
  const ids = picks[l.id] ?? [];
  assert(ids.length === num(l.qty as number), `Za stavku „${l.description}" odaberite točno ${num(l.qty as number)} uređaja (odabrano ${ids.length}).`);
  return ids;
}

async function loadForConvert(tx: Tx, actor: Actor, id: string) {
  await tx.$queryRaw`SELECT id FROM "Quote" WHERE id = ${id} FOR UPDATE`;
  const q = await tx.quote.findFirst({
    where: { id, companyId: actor.companyId },
    include: {
      lines: { orderBy: { sort: 'asc' }, include: { model: true, service: { select: { kpd: true } }, item: { include: { model: true } } } },
      partner: true,
      company: true,
    },
  });
  assert(q, 'Ponuda ne postoji.');
  assert(q.status !== 'REJECTED', 'Odbijena ponuda se ne pretvara.');
  return q;
}

/**
 * Pretvaranje ponude (ili predračuna) u nacrt računa. Stavke po modelu
 * zamjenjuju se točno `qty` odabranih uređaja tog modela sa skladišta (po cijeni
 * iz ponude); stavke najma idu na račun kao stavke najma (mjesečna cijena) —
 * ako je ponuda već pretvorena u ugovor, račun se veže uz taj ugovor.
 */
export async function convertQuote(tx: Tx, actor: Actor, id: string, picks: Record<string, string[]>) {
  const q = await loadForConvert(tx, actor, id);
  assert(!q.invoiceId, 'Ponuda je već pretvorena u račun.');
  const rent = (l: { lineType: string | null }) => l.lineType === 'RENT';

  const picked = q.lines.flatMap((l) => (l.kind === 'MODEL' ? (picks[l.id] ?? []) : []));
  const direct = q.lines.filter((l) => l.kind === 'DEVICE' && l.itemId).map((l) => l.itemId!);
  const all = [...picked, ...direct];
  assert(new Set(all).size === all.length, 'Isti uređaj je odabran više puta.');
  const items = all.length
    ? await tx.item.findMany({
        where: { id: { in: all }, companyId: actor.companyId },
        select: { id: true, serial: true, state: true, modelId: true, warrantyMonths: true, contractItem: { select: { contractId: true } } },
      })
    : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  assert(items.length === all.length, 'Neki odabrani uređaji ne postoje.');
  const rentIds = new Set(
    q.lines.filter(rent).flatMap((l) => (l.kind === 'MODEL' ? (picks[l.id] ?? []) : l.itemId ? [l.itemId] : [])),
  );
  // najam po ugovoru iz ponude: uređaji su već na tom ugovoru; ostali moraju biti na skladištu
  const unavailable = items.filter((i) =>
    rentIds.has(i.id) && q.contractId && i.contractItem?.contractId === q.contractId
      ? false
      : !['IN_STOCK', 'RESERVED'].includes(i.state) || !!i.contractItem,
  );
  assert(!unavailable.length, `Uređaji više nisu na skladištu: ${unavailable.map((i) => i.serial).join(', ')}`);

  const warranty = (m: { warrantyMonths: number | null } | null | undefined) => m?.warrantyMonths ?? q.company.defaultWarrantyMonths;
  const lines: LineInput[] = [];
  for (const l of q.lines) {
    const isRent = rent(l);
    const common = {
      unit: l.unit,
      unitPrice: num(l.unitPrice),
      discountPct: num(l.discountPct),
      lineType: isRent ? ('RENT' as const) : ('SALE' as const),
      // najam: mjesečna cijena, jedan mjesec po stavci (učestalost se zadaje na računu)
      ...(isRent ? { monthly: num(l.monthly ?? l.unitPrice), months: 1 } : {}),
    };
    if (l.kind === 'MODEL') {
      for (const itemId of pickedFor(l, picks)) {
        const it = byId.get(itemId)!;
        assert(it.modelId === l.modelId, `Uređaj ${it.serial} nije model „${l.description}".`);
        lines.push({ kind: 'DEVICE', itemId, modelId: l.modelId, description: l.description, kpd: isRent ? (l.model?.kpdRent ?? null) : l.model?.kpd, qty: 1, warrantyMonths: isRent ? null : (it.warrantyMonths ?? warranty(l.model)), ...common });
      }
    } else if (l.kind === 'DEVICE') {
      assert(l.itemId, `Uređaj sa stavke „${l.description}" više ne postoji.`);
      const it = byId.get(l.itemId)!;
      lines.push({ kind: 'DEVICE', itemId: l.itemId, modelId: l.modelId, description: l.description, kpd: isRent ? (l.item?.model.kpdRent ?? null) : l.item?.model.kpd, qty: 1, warrantyMonths: isRent ? null : (it.warrantyMonths ?? warranty(l.item?.model)), ...common });
    } else {
      lines.push({ kind: l.kind, serviceId: l.serviceId, description: l.description, kpd: l.service?.kpd ?? null, qty: num(l.qty), ...common });
    }
  }

  const vat = customerVat(q.partner, { vatRegistered: q.company.vatRegistered, vatRate: num(q.company.vatRate), country: q.company.country });
  const onlyRent = lines.every((l) => l.lineType === 'RENT');
  const inv = await createDraft(tx, actor, {
    // sve stavke najam → račun za najam; inače prodaja s mogućim stavkama najma (miješani račun)
    type: onlyRent ? 'RENT' : 'SALE',
    partnerId: q.partnerId,
    date: today(),
    // dospijeće se ne upisuje — izdavanje ga računa iz roka plaćanja i stvarnog datuma računa
    dueDate: null,
    // kategorija prema kupcu; stopa iz ponude samo uz standardnu kategoriju (S), inače 0 %
    vatRate: vat.category === 'S' ? num(q.vatRate) : 0,
    taxCategory: vat.category,
    taxExemptReason: vat.exemptReason ?? null,
    discountPct: num(q.discountPct),
    discountAmount: num(q.discountAmount),
    contractId: q.contractId,
    description: `Po ${q.kind === 'PROFORMA' ? 'predračunu' : 'ponudi'} ${q.number}`,
    note: q.note,
    lines,
  });
  await tx.quote.update({ where: { id }, data: { invoiceId: inv.id, status: 'ACCEPTED' } });
  await audit(tx, actor, { entity: 'quote', entityId: id, action: 'convert', summary: `${QUOTE_KIND_LABEL[q.kind]} ${q.number} pretvoren(a) u račun` });
  return inv;
}

export interface QuoteContractInput {
  startDate: string;
  billing: BillingCode;
  /** Trajanje u mjesecima (prazno = neodređeno). */
  months?: number | null;
  seasonFrom?: number | null;
  seasonTo?: number | null;
}

/**
 * Stavke najma s ponude → novi ugovor o najmu: uređaji (stavke po modelu uz
 * odabrane uređaje) idu na ugovor s mjesečnom cijenom iz ponude. Stavke po
 * modelu na ponudi se zamjenjuju odabranim uređajima, pa kasnije pretvaranje u
 * račun zna koje uređaje fakturira.
 */
export async function convertQuoteToContract(tx: Tx, actor: Actor, id: string, picks: Record<string, string[]>, terms: QuoteContractInput) {
  const q = await loadForConvert(tx, actor, id);
  assert(!q.contractId, 'Ponuda je već pretvorena u ugovor.');
  assert(!q.invoiceId, 'Ponuda je već pretvorena u račun — ugovor se otvara iz računa za najam.');
  const rentLines = q.lines.filter((l) => l.lineType === 'RENT' && (l.kind === 'DEVICE' || l.kind === 'MODEL'));
  assert(rentLines.length, 'Ponuda nema uređaja za najam.');
  const monthlyOf = (l: (typeof rentLines)[number]) => r2(num(l.monthly ?? l.unitPrice) * (1 - num(l.discountPct) / 100));

  const rows: Array<{ itemId: string; monthly: number; lineId: string }> = [];
  for (const l of rentLines) {
    if (l.kind === 'MODEL') {
      for (const itemId of pickedFor(l, picks)) rows.push({ itemId, monthly: monthlyOf(l), lineId: l.id });
    } else {
      assert(l.itemId, `Uređaj sa stavke „${l.description}" više ne postoji.`);
      rows.push({ itemId: l.itemId, monthly: monthlyOf(l), lineId: l.id });
    }
  }
  const ids = rows.map((r) => r.itemId);
  assert(new Set(ids).size === ids.length, 'Isti uređaj je odabran više puta.');
  const items = await tx.item.findMany({ where: { id: { in: ids }, companyId: actor.companyId }, select: { id: true, serial: true, modelId: true } });
  assert(items.length === ids.length, 'Neki odabrani uređaji ne postoje.');
  const itemById = new Map(items.map((i) => [i.id, i]));
  for (const l of rentLines.filter((x) => x.kind === 'MODEL')) {
    for (const itemId of picks[l.id] ?? []) assert(itemById.get(itemId)?.modelId === l.modelId, `Uređaj ${itemById.get(itemId)?.serial} nije model „${l.description}".`);
  }

  const endDate = terms.months && terms.months > 0 ? addDays(addMonths(terms.startDate, terms.months), -1) : null;
  const c = await createContract(tx, actor, {
    partnerId: q.partnerId,
    startDate: terms.startDate,
    endDate,
    firstBillingDate: null,
    billingDay: null,
    billing: terms.billing,
    billingMode: 'IN_ADVANCE',
    seasonFrom: terms.seasonFrom ?? null,
    seasonTo: terms.seasonTo ?? null,
    note: `Otvoren iz ${q.kind === 'PROFORMA' ? 'predračuna' : 'ponude'} ${q.number}`,
  });
  await attachItems(tx, actor, c.id, rows.map((r) => ({ itemId: r.itemId, monthly: r.monthly })), { issueDate: terms.startDate });

  // stavke po modelu → odabrani uređaji (ista cijena i popust)
  for (const l of rentLines.filter((x) => x.kind === 'MODEL')) {
    const chosen = picks[l.id] ?? [];
    await tx.quoteLine.delete({ where: { id: l.id } });
    await tx.quoteLine.createMany({
      data: chosen.map((itemId) => ({
        quoteId: q.id,
        sort: l.sort,
        kind: 'DEVICE' as const,
        itemId,
        modelId: l.modelId,
        description: l.description,
        unit: l.unit,
        qty: 1,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
        netAmount: r2(num(l.unitPrice) * (1 - num(l.discountPct) / 100)),
        lineType: 'RENT' as const,
        monthly: l.monthly ?? l.unitPrice,
      })),
    });
  }
  await tx.quote.update({ where: { id }, data: { contractId: c.id, status: 'ACCEPTED' } });
  await audit(tx, actor, { entity: 'quote', entityId: id, action: 'contract', summary: `${QUOTE_KIND_LABEL[q.kind]} ${q.number} pretvoren(a) u ugovor ${c.number} (${rows.length} uređaja)` });
  return c;
}
