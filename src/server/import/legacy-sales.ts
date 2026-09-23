/**
 * Stara baza → plan: računi (vrste, stavke, uplate, storno/odobrenje, naknade)
 * i ponude.
 */
import type { InvoiceKind, InvoiceType, LineKind, PaymentMethod, QuoteStatus } from '@prisma/client';
import type { z } from 'zod';
import type { LegacyCtx } from './legacy-ctx';
import type { LegacyInvoice, LegacyLine, legacyQuote } from './legacy-parse';
import { computeInvoiceTotals, saleShares, type Key, type PlanInvoice, type PlanLine, type PlanQuoteLine } from './plan';
import { regionOf } from '@/domain/tax';
import { r2 } from '@/domain/money';
import type { ChargeInput } from '@/domain/invoice';

export const INVOICE_KIND: Record<string, InvoiceKind> = { racun: 'INVOICE', predujam: 'ADVANCE', storno: 'STORNO', odobrenje: 'CREDIT_NOTE' };
export const INVOICE_TYPE: Record<string, InvoiceType> = { prodaja: 'SALE', najam: 'RENT', servis: 'SERVICE', usluga: 'SERVICE' };
export const QUOTE_STATUS: Record<string, QuoteStatus> = { nacrt: 'DRAFT', poslana: 'SENT', prihvacena: 'ACCEPTED', odbijena: 'REJECTED', istekla: 'SENT' };
const TAX_CATEGORIES = new Set(['S', 'AE', 'K', 'G', 'E', 'O', 'Z']);
const CHARGE_KINDS = new Set(['N', 'POVNAK', 'PP', 'PPMV']);

/** Redni broj iz broja računa („12/ZG/1", „012-1-1", „7") — kao invoiceSeq u staroj verziji. */
export function invoiceSeqOf(number: string | null | undefined): number | null {
  const s = String(number ?? '').trim();
  const m = /^(\d+)\s*[-/_]/.exec(s) ?? /^(\d+)$/.exec(s);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : null;
}

const LINE_KIND: Record<string, LineKind> = { uredaj: 'DEVICE', usluga: 'SERVICE', rucno: 'MANUAL', model: 'MODEL' };

/** Stavka računa ili ponude. */
function mapLine(ctx: LegacyCtx, l: LegacyLine, where: string, opts: { type: InvoiceType; kind: InvoiceKind | 'QUOTE' }): PlanLine {
  const item = l.itemId ? ctx.item(l.itemId, where) : null;
  let kind: LineKind = LINE_KIND[l.kind] ?? (l.itemId ? 'DEVICE' : l.serviceId ? 'SERVICE' : l.modelId ? 'MODEL' : 'MANUAL');
  if (l.kind && !LINE_KIND[l.kind] && !['najam', 'prodaja'].includes(l.kind)) ctx.w.info('line-kind', 'stavka', `${where}: nepoznata vrsta stavke „${l.kind}" — prepoznata po sadržaju.`);
  if (kind === 'DEVICE' && !item) kind = 'MANUAL';
  const serviceKey = l.serviceId ? (ctx.services.get(l.serviceId) ?? null) : null;
  if (l.serviceId && !serviceKey) ctx.w.warn('ref-service', 'veza', `${where}: usluga „${l.serviceId}" ne postoji — stavka ostaje ručna.`);
  if (kind === 'SERVICE' && !serviceKey) kind = 'MANUAL';
  const modelKey = item?.modelKey ?? (l.modelId ? (ctx.models.get(l.modelId) ?? null) : null);
  // stavka bez serijskog postoji samo na ponudi; izdani račun je nema
  if (kind === 'MODEL' && (!modelKey || opts.kind !== 'QUOTE')) kind = 'MANUAL';

  let qty = ctx.num(l.qty, where, 'količina', 1);
  if (qty === 0) qty = 1; // stara verzija računa (qty || 1)
  let unitPrice = ctx.money(l.price, where, 'cijena', 0);
  let monthly = ctx.money(l.monthly, where, 'mjesečno', null);
  if (monthly === 0) monthly = null;
  const discountPct = ctx.num(l.discount, where, 'popust', 0);

  // storno i odobrenje: stara verzija ima negativnu cijenu, nova negativnu količinu
  if ((opts.kind === 'STORNO' || opts.kind === 'CREDIT_NOTE') && unitPrice < 0 && qty > 0) {
    qty = -qty;
    unitPrice = -unitPrice;
    if (monthly !== null && monthly < 0) monthly = -monthly;
  }
  let months: number | null = null;
  if (monthly) {
    const m = Math.round(unitPrice / monthly);
    if (m > 0 && Math.abs(r2(m * monthly) - unitPrice) < 0.01) months = m;
  }

  const serial = l.serial || item?.serial || '';
  let description = l.desc || l.description || '';
  if (!description) description = (modelKey && ctx.modelLabels.get(modelKey)) || (serviceKey && ctx.serviceNames.get(serviceKey)) || '—';
  // storno ne vodi uređaj kao stavku (kao u ovoj aplikaciji), pa serijski ide u opis
  const correction = opts.kind === 'STORNO' || opts.kind === 'CREDIT_NOTE';
  if (kind === 'DEVICE' && correction) kind = 'MANUAL';
  if (kind === 'MANUAL' && serial && !description.includes(serial)) description = `${description}, SN ${serial}`;

  const cost = opts.type === 'SALE' && item && (opts.kind === 'INVOICE' || opts.kind === 'STORNO') ? r2(item.cost * Math.sign(qty)) : 0;
  return {
    kind,
    itemKey: kind === 'DEVICE' && item ? item.key : null,
    modelKey,
    serviceKey: kind === 'SERVICE' ? serviceKey : null,
    description,
    unit: l.unit || (monthly !== null ? 'mj' : 'kom'),
    kpd: l.kpd || null,
    qty,
    monthly,
    months,
    unitPrice,
    discountPct,
    cost,
    warrantyMonths: ctx.int(l.warrantyMonths, where, 'jamstvo', 0, 600),
    agreedPrice: !!l.agreed,
  };
}

function taxCategoryFor(ctx: LegacyCtx, raw: string, vatRate: number, partnerKey: Key): string {
  const c = raw.toUpperCase();
  if (TAX_CATEGORIES.has(c)) return c;
  if (vatRate > 0) return 'S';
  if (!ctx.vatRegistered) return 'O';
  const region = regionOf(ctx.partnerCountry.get(partnerKey) ?? 'HR');
  return region === 'EU' ? 'K' : region === 'NON_EU' ? 'G' : 'E';
}

function paymentMethodOf(v: string): PaymentMethod {
  const s = v.toLowerCase();
  if (/gotov|cash/.test(s)) return 'CASH';
  if (/kartic|card/.test(s)) return 'CARD';
  if (/ostal|other/.test(s)) return 'OTHER';
  return 'TRANSFER';
}

/** Računi: prvi prolaz stvara zapise, drugi razrješava veze (storno, odobrenje). */
export function mapInvoices(ctx: LegacyCtx, rows: LegacyInvoice[]) {
  const seqSeen = new Set<string>();
  const legacyFullPayment = new Map<Key, string>();
  const stornoIds = new Map<Key, string>();
  const refIds = new Map<Key, string>();

  // stariji brojevi prvi, pa duplikat dobije kasniji zapis
  for (const [i, r] of rows.entries()) {
    const key = r.id ?? ctx.genKey('invoice');
    const where = `Račun ${r.number || `#${i + 1}`}`;
    if (ctx.invoices.has(key)) {
      ctx.w.warn('dup-id', 'račun', `${where}: id „${key}" se ponavlja — drugi zapis preskočen.`);
      continue;
    }
    const date = ctx.reqDate(where, 'datum', r.date, r.createdAt);
    const year = Number(date.slice(0, 4));
    const kind = INVOICE_KIND[r.kind || 'racun'];
    if (!kind) ctx.w.warn('invoice-kind', 'račun', `${where}: nepoznata vrsta „${r.kind}" — uvezen kao račun.`);
    const type = INVOICE_TYPE[r.type] ?? (r.contractId || r.rental ? 'RENT' : 'SALE');
    if (r.type && !INVOICE_TYPE[r.type]) ctx.w.warn('invoice-type', 'račun', `${where}: nepoznata vrsta prometa „${r.type}" — uvezen kao ${type === 'RENT' ? 'najam' : 'prodaja'}.`);

    const number = r.number || null;
    let seq = invoiceSeqOf(number);
    if (!number) ctx.w.info('invoice-draft', 'račun', `Račun bez broja (${date}) uvezen je kao nacrt.`);
    else if (!seq) ctx.w.warn('invoice-seq', 'račun', `${where}: broj ne počinje rednim brojem — uvezen kao izdan, bez rednog broja.`);
    if (seq) {
      const k = `${year}|${seq}`;
      if (seqSeen.has(k)) {
        ctx.w.warn('invoice-dup-seq', 'račun', `${where}: redni broj ${seq} u ${year}. već postoji — ovaj račun zadržava broj, ali bez rednog broja.`);
        seq = null;
      } else {
        seqSeen.add(k);
        ctx.numbers.seen('INVOICE', year, seq);
      }
    }

    let partnerKey = ctx.partner(r.partnerId, where, 'kupac');
    if (!partnerKey) {
      if (!r.partnerId) ctx.w.warn('ref-partner', 'veza', `${where}: nema kupca — vezan uz „Nepoznat kupac (uvoz)".`);
      partnerKey = ctx.customerPlaceholder();
    }
    const vatRate = ctx.num(r.vatRate, where, 'PDV', 25);
    const k = kind ?? 'INVOICE';
    const lines = r.lines.filter(Boolean).map((l, j) => mapLine(ctx, l, `${where}, stavka ${j + 1}`, { type, kind: k }));
    if (!lines.length) ctx.w.info('invoice-empty', 'račun', `${where}: račun nema stavki.`);

    const charges: ChargeInput[] = r.charges
      .filter(Boolean)
      .filter((c) => CHARGE_KINDS.has(c.kind || 'N'))
      .map((c) => ({
        kind: (c.kind || 'N') as ChargeInput['kind'],
        label: c.label || undefined,
        amount: ctx.money(c.amount, where, 'naknada', null) ?? undefined,
        pct: ctx.num(c.pct, where, 'naknada %', null) ?? undefined,
      }));

    const inv: PlanInvoice = {
      key,
      status: number ? 'ISSUED' : 'DRAFT',
      kind: k,
      type,
      seq,
      year,
      number,
      partnerKey,
      date,
      dueDate: ctx.date(r.dueDate, where, 'dospijeće'),
      deliveryDate: ctx.date(r.deliveryDate, where, 'datum isporuke'),
      vatRate,
      taxCategory: taxCategoryFor(ctx, r.taxCategory, vatRate, partnerKey),
      taxExemptReason: r.taxReason || null,
      discountPct: Math.abs(ctx.num(r.discountPct, where, 'popust %', 0)),
      discountAmount: Math.abs(ctx.money(r.discountAmount, where, 'popust', 0)),
      charges,
      advanceAmount: ctx.money(r.advanceAmount, where, 'predujam', 0),
      stornoed: false,
      refInvoiceKey: null,
      contractKey: null,
      period: /^\d{4}-(0[1-9]|1[0-2])$/.test(r.period) ? r.period : null,
      description: r.description || null,
      note: r.note || null,
      paymentRef: seq ? `${seq}-${year}` : null,
      paymentMethod: paymentMethodOf(r.paymentMethod),
      eInvoice: r.eracun && Object.keys(r.eracun).length
        ? { status: r.eracun.status ?? r.eracun.statusText ?? null, sentAt: r.eracun.sentAt ?? null, id: r.eracun.id ?? null, error: r.eracun.error ?? null }
        : {},
      createdBy: ctx.user(r.createdBy),
      issuedBy: number ? ctx.user(r.createdBy) : null,
      issuedAt: number ? (ctx.ts(r.createdAt) ?? `${date}T12:00:00.000Z`) : null,
      createdAt: ctx.ts(r.createdAt),
      lines,
      payments: [],
    };
    if (r.contractId) {
      if (ctx.contracts.has(r.contractId)) inv.contractKey = r.contractId;
      else ctx.w.warn('ref-contract', 'veza', `${where}: ugovor „${r.contractId}" ne postoji — veza izostavljena.`);
    }
    if (r.period && !inv.period) ctx.w.warn('invoice-period', 'račun', `${where}: razdoblje „${r.period}" nije oblika GGGG-MM — izostavljeno.`);

    const receivable = k === 'INVOICE' || k === 'ADVANCE';
    const payments = r.payments.filter(Boolean);
    if (receivable && payments.length) {
      for (const p of payments) {
        const amount = ctx.money(p.amount, where, 'uplata', null);
        if (!amount) continue;
        inv.payments.push({ date: ctx.date(p.date, where, 'datum uplate') ?? date, amount, method: p.method || null, note: p.note || null, createdBy: p.by || null });
      }
    } else if (receivable && r.paidDate) {
      const d = ctx.date(r.paidDate, where, 'plaćeno');
      if (d) legacyFullPayment.set(key, d);
    }
    if (r.stornoId) stornoIds.set(key, r.stornoId);
    if (r.refInvoiceId) refIds.set(key, r.refInvoiceId);
    ctx.invoices.set(key, inv);
    ctx.plan.invoices.push(inv);
  }

  // veze storno / odobrenje ↔ izvorni
  for (const inv of ctx.plan.invoices) {
    const ref = refIds.get(inv.key);
    if (ref) {
      if (ctx.invoices.has(ref)) inv.refInvoiceKey = ref;
      else ctx.w.warn('ref-invoice', 'veza', `Račun ${inv.number ?? inv.key}: izvorni račun „${ref}" ne postoji — veza izostavljena.`);
    }
    if ((inv.kind === 'STORNO' || inv.kind === 'CREDIT_NOTE') && !inv.refInvoiceKey) {
      ctx.w.info('correction-no-ref', 'račun', `${inv.kind === 'STORNO' ? 'Storno' : 'Odobrenje'} ${inv.number ?? ''} nije vezan uz izvorni račun.`);
    }
  }
  for (const inv of ctx.plan.invoices) {
    if (inv.kind === 'STORNO' && inv.refInvoiceKey) ctx.invoices.get(inv.refInvoiceKey)!.stornoed = true;
    const s = stornoIds.get(inv.key);
    if (s) {
      if (!ctx.invoices.has(s)) ctx.w.warn('ref-storno', 'veza', `Račun ${inv.number ?? inv.key}: storno „${s}" ne postoji, račun se ipak vodi kao storniran.`);
      inv.stornoed = true;
    }
  }
  for (const inv of ctx.plan.invoices) {
    if (inv.stornoed) {
      if (inv.payments.length) ctx.w.info('stornoed-payments', 'račun', `Račun ${inv.number}: storniran, a ima uplate — uplate su uvezene, otvoreni iznos je 0.`);
      legacyFullPayment.delete(inv.key);
    }
  }

  // stari „paidDate" bez uplata = plaćeno u cijelosti → jedna uplata otvorenog iznosa
  computeInvoiceTotals(ctx.plan.invoices);
  for (const [key, date] of legacyFullPayment) {
    const inv = ctx.invoices.get(key)!;
    const open = inv.totals?.openAmount ?? 0;
    if (open > 0) inv.payments.push({ date, amount: open, method: null, note: 'Plaćeno u cijelosti (uvoz iz stare verzije)', createdBy: null });
  }
  computeInvoiceTotals(ctx.plan.invoices);

}

/** Ostvarena prodajna cijena prodanog uređaja bez vlastite cijene — udio s njegovog računa, kao pri izdavanju. */
export function applySalePrices(ctx: LegacyCtx) {
  for (const inv of ctx.plan.invoices) {
    if (inv.type !== 'SALE' || inv.kind !== 'INVOICE' || inv.status !== 'ISSUED' || inv.stornoed) continue;
    for (const [itemKey, share] of saleShares(inv)) {
      const item = ctx.items.get(itemKey); // ključ uređaja je njegov id iz stare baze
      if (item && item.state === 'SOLD' && item.invoiceKey === inv.key && item.salePrice === null) item.salePrice = share;
    }
  }
}

/** Ponude — isti oblik stavki kao računi. */
export function mapQuotes(ctx: LegacyCtx, rows: Array<z.infer<typeof legacyQuote>>) {
  const usedInvoices = new Set<Key>();
  for (const [i, r] of rows.entries()) {
    const where = `Ponuda ${r.number || `#${i + 1}`}`;
    const date = ctx.reqDate(where, 'datum', r.date, r.createdAt);
    const status = QUOTE_STATUS[r.status || 'nacrt'];
    if (!status) ctx.w.warn('quote-status', 'ponuda', `${where}: nepoznato stanje „${r.status}" — uvezena kao nacrt.`);
    if (r.status === 'istekla') ctx.w.info('quote-expired', 'ponuda', `${where}: „istekla" se vodi kao poslana — istek se vidi iz roka valjanosti.`);
    let partnerKey = ctx.partner(r.partnerId, where, 'kupac');
    if (!partnerKey) partnerKey = ctx.customerPlaceholder();
    let invoiceKey: Key | null = null;
    if (r.invoiceId) {
      if (!ctx.invoices.has(r.invoiceId)) ctx.w.warn('ref-invoice', 'veza', `${where}: račun „${r.invoiceId}" ne postoji.`);
      else if (usedInvoices.has(r.invoiceId)) ctx.w.warn('quote-invoice-dup', 'ponuda', `${where}: račun je već vezan uz drugu ponudu — veza izostavljena.`);
      else {
        invoiceKey = r.invoiceId;
        usedInvoices.add(r.invoiceId);
      }
    }
    const number = r.number ? ctx.numbers.unique('QUOTE', r.number) : ctx.numbers.next('QUOTE', Number(date.slice(0, 4)));
    const lines: PlanQuoteLine[] = r.lines.filter(Boolean).map((l, j) => {
      const pl = mapLine(ctx, l, `${where}, stavka ${j + 1}`, { type: 'SALE', kind: 'QUOTE' });
      return { kind: pl.kind, itemKey: pl.itemKey, modelKey: pl.modelKey, serviceKey: pl.serviceKey, description: pl.description, unit: pl.unit, qty: pl.qty, unitPrice: pl.unitPrice, discountPct: pl.discountPct };
    });
    const desc = r.description ? `${r.description}${r.note ? `\n${r.note}` : ''}` : r.note || null;
    ctx.plan.quotes.push({
      key: r.id ?? ctx.genKey('quote'),
      number,
      generatedNumber: !r.number,
      date,
      validUntil: ctx.date(r.validUntil, where, 'vrijedi do'),
      partnerKey,
      status: status ?? 'DRAFT',
      vatRate: ctx.num(r.vatRate, where, 'PDV', 25),
      discountPct: Math.abs(ctx.num(r.discountPct, where, 'popust %', 0)),
      discountAmount: Math.abs(ctx.money(r.discountAmount, where, 'popust', 0)),
      hideSerials: !!r.hideSerials,
      note: desc,
      invoiceKey,
      createdBy: ctx.user(r.createdBy),
      createdAt: ctx.ts(r.createdAt),
      lines,
    });
  }
}
