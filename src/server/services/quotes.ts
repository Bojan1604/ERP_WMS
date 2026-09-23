import 'server-only';
import type { LineKind, QuoteStatus } from '@prisma/client';
import type { Tx } from '../db';
import { assert } from '../errors';
import { audit } from '../audit';
import { nextDocNumber } from '../numbering';
import { createDraft, type LineInput } from './invoices';
import type { Actor } from './items';
import { documentTotals } from '@/domain/invoice';
import { customerVat } from '@/domain/tax';
import { addDays, fromISO, today } from '@/domain/dates';
import { num } from '@/domain/money';

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
}

export interface QuoteInput {
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
    const number = await nextDocNumber(tx, actor.companyId, 'QUOTE', Number(input.date.slice(0, 4)));
    const q = await tx.quote.create({
      data: { companyId: actor.companyId, number, ...header, createdBy: actor.name, lines: { create: lineRows(input, t.lineNets) } },
    });
    await audit(tx, actor, { entity: 'quote', entityId: q.id, action: 'create', summary: `Ponuda ${number} za ${partner.name}` });
    return q;
  }
  const q = await tx.quote.findFirst({ where: { id, companyId: actor.companyId } });
  assert(q, 'Ponuda ne postoji.');
  assert(!q.invoiceId, 'Ponuda je pretvorena u račun i više se ne mijenja.');
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
  await tx.quote.delete({ where: { id } });
  await audit(tx, actor, { entity: 'quote', entityId: id, action: 'delete', summary: `Ponuda ${q.number} obrisana` });
}

/**
 * Pretvaranje ponude u nacrt računa. Stavke po modelu zamjenjuju se točno
 * `qty` odabranih uređaja tog modela sa skladišta (po cijeni iz ponude);
 * ponuda se veže uz račun i postaje prihvaćena.
 */
export async function convertQuote(tx: Tx, actor: Actor, id: string, picks: Record<string, string[]>) {
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
  assert(!q.invoiceId, 'Ponuda je već pretvorena u račun.');
  assert(q.status !== 'REJECTED', 'Odbijena ponuda se ne pretvara u račun.');

  const picked = q.lines.flatMap((l) => (l.kind === 'MODEL' ? (picks[l.id] ?? []) : []));
  const direct = q.lines.filter((l) => l.kind === 'DEVICE' && l.itemId).map((l) => l.itemId!);
  const all = [...picked, ...direct];
  assert(new Set(all).size === all.length, 'Isti uređaj je odabran više puta.');
  const items = all.length
    ? await tx.item.findMany({
        where: { id: { in: all }, companyId: actor.companyId },
        select: { id: true, serial: true, state: true, modelId: true, warrantyMonths: true, contractItem: { select: { id: true } } },
      })
    : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const unavailable = items.filter((i) => !['IN_STOCK', 'RESERVED'].includes(i.state) || i.contractItem);
  assert(!unavailable.length, `Uređaji više nisu na skladištu: ${unavailable.map((i) => i.serial).join(', ')}`);
  assert(items.length === all.length, 'Neki odabrani uređaji ne postoje.');

  const warranty = (m: { warrantyMonths: number | null } | null | undefined) => m?.warrantyMonths ?? q.company.defaultWarrantyMonths;
  const lines: LineInput[] = [];
  for (const l of q.lines) {
    const common = { unit: l.unit, unitPrice: num(l.unitPrice), discountPct: num(l.discountPct) };
    if (l.kind === 'MODEL') {
      const ids = picks[l.id] ?? [];
      assert(ids.length === num(l.qty), `Za stavku „${l.description}" odaberite točno ${num(l.qty)} uređaja (odabrano ${ids.length}).`);
      for (const itemId of ids) {
        const it = byId.get(itemId)!;
        assert(it.modelId === l.modelId, `Uređaj ${it.serial} nije model „${l.description}".`);
        lines.push({ kind: 'DEVICE', itemId, modelId: l.modelId, description: l.description, kpd: l.model?.kpd, qty: 1, warrantyMonths: it.warrantyMonths ?? warranty(l.model), ...common });
      }
    } else if (l.kind === 'DEVICE') {
      assert(l.itemId, `Uređaj sa stavke „${l.description}" više ne postoji.`);
      const it = byId.get(l.itemId)!;
      lines.push({ kind: 'DEVICE', itemId: l.itemId, modelId: l.modelId, description: l.description, kpd: l.item?.model.kpd, qty: 1, warrantyMonths: it.warrantyMonths ?? warranty(l.item?.model), ...common });
    } else {
      lines.push({ kind: l.kind, serviceId: l.serviceId, description: l.description, kpd: l.service?.kpd ?? null, qty: num(l.qty), ...common });
    }
  }

  const vat = customerVat(q.partner.country, { vatRegistered: q.company.vatRegistered, vatRate: num(q.company.vatRate), country: q.company.country });
  const date = today();
  const inv = await createDraft(tx, actor, {
    type: 'SALE',
    partnerId: q.partnerId,
    date,
    dueDate: addDays(date, q.partner.paymentTermDays ?? q.company.paymentTermDays),
    vatRate: num(q.vatRate),
    taxCategory: vat.category,
    taxExemptReason: vat.exemptReason ?? null,
    discountPct: num(q.discountPct),
    discountAmount: num(q.discountAmount),
    description: `Po ponudi ${q.number}`,
    note: q.note,
    lines,
  });
  await tx.quote.update({ where: { id }, data: { invoiceId: inv.id, status: 'ACCEPTED' } });
  await audit(tx, actor, { entity: 'quote', entityId: id, action: 'convert', summary: `Ponuda ${q.number} pretvorena u račun` });
  return inv;
}
