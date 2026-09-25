import 'server-only';
import type { Prisma, Series } from '@prisma/client';
import { nextDocNumber } from '../numbering';
import { recalcInvoice } from '../services/invoices';
import { normalizeItemState, type ImportPlan, type Key, type PlanItem } from './plan';
import { bulkInsert, chunks, d, newId, ts, type RunCtx } from './run';
import { documentTotals } from '@/domain/invoice';
import { checkAttachmentBytes, safeFileName } from '@/domain/attachments';
import { isAttachmentEntity } from '../services/attachments';

/**
 * Upis dokumenata plana (ugovori, računi, uređaji, nabava, servis, troškovi,
 * povijest) — skupno, redom kojim to traže strani ključevi.
 */

const low = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Broj dokumenta: postojeći zapis s istim brojem se preskače; dodijeljeni broj se u postojećoj firmi uzima iz brojača. */
async function numbered<R extends { key: Key; number: string; generatedNumber?: boolean }>(
  c: RunCtx,
  entity: string,
  series: Exclude<Series, 'INVOICE'>,
  rows: R[],
  existing: () => Promise<Array<{ id: string; number: string }>>,
  yearOf: (r: R) => number,
): Promise<Array<R & { id: string; number: string }>> {
  const have = c.existing ? new Map((await existing()).map((r) => [low(r.number), r.id])) : new Map<string, string>();
  const out: Array<R & { id: string; number: string }> = [];
  for (const r of rows) {
    let number = r.number;
    if (c.existing && r.generatedNumber) number = await nextDocNumber(c.tx, c.companyId, series, yearOf(r));
    else if (have.has(low(number))) {
      c.map(entity).set(r.key, have.get(low(number))!);
      c.count(entity, 0, 1);
      continue;
    }
    out.push({ ...r, number, id: c.assign(entity, r.key) });
  }
  return out;
}

export async function insertDocuments(c: RunCtx, plan: ImportPlan) {
  const { tx, companyId } = c;
  const where = { where: { companyId }, select: { id: true, number: true } } as const;

  // ---------------------------------------------------------------- ugovori
  const contracts = await numbered(c, 'contracts', 'CONTRACT', plan.contracts, () => tx.contract.findMany(where), (r) => Number(r.startDate.slice(0, 4)));
  await bulkInsert(tx, 'Contract', contracts.map((k) => ({
        id: k.id, companyId, number: k.number, partnerId: c.id('partners', k.partnerKey)!, status: k.status, startDate: d(k.startDate)!,
        endDate: d(k.endDate), firstBillingDate: d(k.firstBillingDate), billingDay: k.billingDay, billing: k.billing, billingMode: k.billingMode,
        seasonFrom: k.seasonFrom, seasonTo: k.seasonTo, terminatedAt: d(k.terminatedAt), note: k.note, createdBy: k.createdBy, createdAt: ts(k.createdAt),
  } satisfies Prisma.ContractCreateManyInput)));
  c.count('contracts', contracts.length);
  c.step('contracts', contracts.length);

  // ---------------------------------------------------------------- računi (zaglavlja)
  const haveSeq = c.existing
    ? new Map((await tx.invoice.findMany({ where: { companyId, seq: { not: null } }, select: { id: true, year: true, seq: true } })).map((i) => [`${i.year}|${i.seq}`, i.id]))
    : new Map<string, string>();
  const invoices: ImportPlan['invoices'] = [];
  for (const inv of plan.invoices) {
    const found = inv.seq ? haveSeq.get(`${inv.year}|${inv.seq}`) : undefined;
    if (found) {
      c.map('invoices').set(inv.key, found);
      c.count('invoices', 0, 1);
      continue;
    }
    c.assign('invoices', inv.key);
    invoices.push(inv);
  }
  const toRow = (inv: (typeof invoices)[number]): Prisma.InvoiceCreateManyInput => {
    const t = inv.totals!;
    return {
      id: c.id('invoices', inv.key)!, companyId, status: inv.status, kind: inv.kind, type: inv.type, seq: inv.seq, year: inv.year, number: inv.number,
      partnerId: c.id('partners', inv.partnerKey)!, date: d(inv.date)!, dueDate: d(inv.dueDate), deliveryDate: d(inv.deliveryDate), vatRate: inv.vatRate,
      taxCategory: inv.taxCategory, taxExemptReason: inv.taxExemptReason, discountPct: inv.discountPct, discountAmount: inv.discountAmount,
      charges: json(inv.charges), advanceAmount: inv.advanceAmount, stornoed: inv.stornoed, netTotal: t.netTotal, vatTotal: t.vatTotal,
      chargesTotal: t.chargesTotal, grandTotal: t.grandTotal, paidTotal: t.paidTotal, creditedTotal: t.creditedTotal, openAmount: t.openAmount,
      costTotal: t.costTotal, paidDate: d(t.paidDate), refInvoiceId: c.id('invoices', inv.refInvoiceKey), contractId: c.id('contracts', inv.contractKey),
      period: inv.period, description: inv.description, note: inv.note, paymentRef: inv.paymentRef, eInvoice: json(inv.eInvoice), paymentMethod: inv.paymentMethod,
      zki: inv.zki ?? null, jir: inv.jir ?? null, fiscalStatus: inv.fiscalStatus ?? 'NOT_REQUIRED', fiscalizedAt: ts(inv.fiscalizedAt) ?? null,
      createdBy: inv.createdBy, issuedBy: inv.issuedBy, issuedAt: ts(inv.issuedAt) ?? null, createdAt: ts(inv.createdAt),
    };
  };
  // izvorni računi prije storna i odobrenja koji ih referenciraju
  const first = invoices.filter((i) => !c.isFresh('invoices', i.refInvoiceKey));
  const second = invoices.filter((i) => c.isFresh('invoices', i.refInvoiceKey));
  await bulkInsert(tx, 'Invoice', first.map(toRow));
  await bulkInsert(tx, 'Invoice', second.map(toRow));
  c.count('invoices', invoices.length);
  c.step('invoices', invoices.length);

  // ---------------------------------------------------------------- nabava
  const orders = await numbered(c, 'orders', 'ORDER', plan.orders, () => tx.purchaseOrder.findMany(where), (r) => Number(r.date.slice(0, 4)));
  await bulkInsert(tx, 'PurchaseOrder', orders.map((o) => ({
        id: o.id, companyId, number: o.number, supplierId: c.id('partners', o.supplierKey)!, date: d(o.date)!, expectedDate: d(o.expectedDate), status: o.status,
        total: Math.round(o.lines.reduce((a, l) => a + l.qty * l.unitCost, 0) * 100) / 100, note: o.note, createdBy: o.createdBy, createdAt: ts(o.createdAt),
  } satisfies Prisma.PurchaseOrderCreateManyInput)));
  const orderLines = orders.flatMap((o) => o.lines.map((l) => ({ id: newId(), orderId: o.id, modelId: c.id('models', l.modelKey)!, qty: l.qty, unitCost: l.unitCost, received: l.received })));
  await bulkInsert(tx, 'PurchaseOrderLine', orderLines);
  c.count('orders', orders.length);
  const receipts = await numbered(c, 'receipts', 'RECEIPT', plan.receipts, () => tx.goodsReceipt.findMany(where), (r) => Number(r.date.slice(0, 4)));
  await bulkInsert(tx, 'GoodsReceipt', receipts.map((r) => ({
        id: r.id, companyId, number: r.number, date: d(r.date)!, supplierId: c.id('partners', r.supplierKey), orderId: c.id('orders', r.orderKey),
        warehouseId: c.id('warehouses', r.warehouseKey)!, supplierDocNumber: r.supplierDocNumber, status: r.status, total: r.total, note: r.note,
        createdBy: r.createdBy, createdAt: ts(r.createdAt),
  } satisfies Prisma.GoodsReceiptCreateManyInput)));
  c.count('receipts', receipts.length);
  c.step('orders+receipts', orders.length + receipts.length);

  // ---------------------------------------------------------------- uređaji
  await insertItems(c, plan.items, plan.source.format === 'erp-wms-backup' ? 'Vraćeno iz sigurnosne kopije' : 'Uvezeno iz stare verzije');

  // ---------------------------------------------------------------- stavke i uplate računa
  const lines: Prisma.InvoiceLineCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = [];
  for (const inv of invoices) {
    const invoiceId = c.id('invoices', inv.key)!;
    inv.lines.forEach((l, sort) => lines.push({
      id: newId(), invoiceId, sort, kind: l.kind, itemId: c.id('items', l.itemKey), modelId: c.id('models', l.modelKey), serviceId: c.id('services', l.serviceKey),
      description: l.description, unit: l.unit, kpd: l.kpd, qty: l.qty, monthly: l.monthly, months: l.months, unitPrice: l.unitPrice, discountPct: l.discountPct,
      netAmount: inv.totals!.lineNets[sort] ?? 0, cost: l.cost, warrantyMonths: l.warrantyMonths, agreedPrice: l.agreedPrice,
    }));
    for (const p of inv.payments) payments.push({ id: newId(), invoiceId, date: d(p.date)!, amount: p.amount, method: p.method, note: p.note, createdBy: p.createdBy });
  }
  await bulkInsert(tx, 'InvoiceLine', lines);
  await bulkInsert(tx, 'Payment', payments);
  c.count('invoiceLines', lines.length);
  c.count('payments', payments.length);
  c.step('invoiceLines+payments', lines.length + payments.length);

  // ispravak postojećeg računa (u postojećoj firmi) → preračun njegovih zbrojeva
  for (const inv of c.existing ? first : []) {
    const ref = c.id('invoices', inv.refInvoiceKey);
    if (!ref) continue;
    if (inv.kind === 'STORNO') await tx.invoice.update({ where: { id: ref }, data: { stornoed: true } });
    await recalcInvoice(tx, ref);
  }

  // ---------------------------------------------------------------- najam
  const contractItems: Prisma.ContractItemCreateManyInput[] = [];
  for (const k of plan.contracts) {
    if (!c.isFresh('contracts', k.key)) continue;
    const contractId = c.id('contracts', k.key)!;
    for (const ci of k.items) {
      const itemId = c.id('items', ci.itemKey);
      if (!itemId) continue;
      contractItems.push({ id: newId(), contractId, itemId, monthly: ci.monthly, plan: json(ci.plan), status: ci.status, skipped: ci.skipped, paused: ci.paused ?? [] });
    }
  }
  const ciCount = await bulkInsert(tx, 'ContractItem', contractItems, { skipDuplicates: true });
  c.count('contractItems', ciCount, contractItems.length - ciCount);
  const overrides = plan.rentOverrides
    .map((r) => ({ companyId, itemId: c.id('items', r.itemKey)!, year: r.year, month: r.month, amount: r.amount }))
    .filter((r) => r.itemId);
  const roCount = await bulkInsert(tx, 'RentOverride', overrides, { skipDuplicates: true });
  c.count('rentOverrides', roCount, overrides.length - roCount);
  c.step('contractItems+rentOverrides', ciCount + roCount);

  await insertOther(c, plan);
}

async function insertItems(c: RunCtx, items: PlanItem[], label: string) {
  const { tx, companyId } = c;
  const have = c.existing
    ? new Map((await tx.item.findMany({ where: { companyId }, select: { id: true, serial: true, dupNote: true } })).map((i) => [`${i.serial}|${low(i.dupNote)}`, i.id]))
    : new Map<string, string>();
  const statusKinds = c.existing
    ? new Map((await tx.itemStatus.findMany({ where: { companyId }, select: { id: true, kind: true } })).map((s) => [s.id, s.kind]))
    : null;
  const rows: Prisma.ItemCreateManyInput[] = [];
  const events: Prisma.ItemEventCreateManyInput[] = [];
  const statusNames = new Map<string, string>();
  for (const s of await tx.itemStatus.findMany({ where: { companyId }, select: { id: true, name: true } })) statusNames.set(s.id, s.name);
  const at = new Date();
  for (const src of items) {
    const found = have.get(`${src.serial}|${low(src.dupNote)}`);
    if (found) {
      c.map('items').set(src.key, found);
      c.count('items', 0, 1);
      continue;
    }
    const id = c.assign('items', src.key);
    have.set(`${src.serial}|${low(src.dupNote)}`, id);
    const statusId = c.id('statuses', src.statusKey)!;
    let it = src;
    // postojeći status istog naziva može biti druge vrste — stanje prati stvarni status
    const kind = statusKinds?.get(statusId);
    if (kind && kind !== src.state) {
      it = { ...src, state: kind };
      normalizeItemState(it);
    }
    rows.push({
      id, companyId, serial: it.serial, dupNote: it.dupNote, modelId: c.id('models', it.modelKey)!, statusId, state: it.state,
      warehouseId: c.id('warehouses', it.warehouseKey), supplierId: c.id('partners', it.supplierKey), partnerId: c.id('partners', it.partnerKey),
      invoiceId: c.id('invoices', it.invoiceKey), receiptId: c.id('receipts', it.receiptKey), cost: it.cost, salePrice: it.salePrice, rentPrice: it.rentPrice,
      marginPct: it.marginPct, importDate: d(it.importDate), issueDate: d(it.issueDate), warrantyStart: d(it.warrantyStart), warrantyMonths: it.warrantyMonths,
      outAt: ts(it.outAt) ?? null, outPartnerId: c.id('partners', it.outPartnerKey), outNote: it.outNote, writeOffDate: d(it.writeOffDate),
      writeOffReason: it.writeOffReason, note: it.note, createdAt: ts(it.createdAt),
    });
    events.push({
      id: newId(), companyId, itemId: id, at, type: 'IMPORT', message: `${label} — status „${statusNames.get(statusId) ?? it.state}"`,
      userName: c.actor.name,
    });
  }
  await bulkInsert(tx, 'Item', rows);
  c.count('items', rows.length);
  c.step('items', rows.length);
  c.pendingEvents.push(...events);
}

async function insertOther(c: RunCtx, plan: ImportPlan) {
  const { tx, companyId } = c;
  const where = { where: { companyId }, select: { id: true, number: true } } as const;

  // ponude (račun smije biti vezan uz najviše jednu ponudu)
  const quotes = await numbered(c, 'quotes', 'QUOTE', plan.quotes, () => tx.quote.findMany(where), (r) => Number(r.date.slice(0, 4)));
  const takenInvoices = new Set(c.existing ? (await tx.quote.findMany({ where: { companyId, invoiceId: { not: null } }, select: { invoiceId: true } })).map((q) => q.invoiceId!) : []);
  const quoteLines: Prisma.QuoteLineCreateManyInput[] = [];
  const quoteRows: Prisma.QuoteCreateManyInput[] = quotes.map((q) => {
    const t = documentTotals({ lines: q.lines, vatRate: q.vatRate, discountPct: q.discountPct, discountAmount: q.discountAmount });
    q.lines.forEach((l, sort) => quoteLines.push({
      id: newId(), quoteId: q.id, sort, kind: l.kind, itemId: c.id('items', l.itemKey), modelId: c.id('models', l.modelKey), serviceId: c.id('services', l.serviceKey),
      description: l.description, unit: l.unit, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, netAmount: t.lineNets[sort],
    }));
    let invoiceId = c.id('invoices', q.invoiceKey);
    if (invoiceId && takenInvoices.has(invoiceId)) invoiceId = null;
    if (invoiceId) takenInvoices.add(invoiceId);
    return {
      id: q.id, companyId, number: q.number, date: d(q.date)!, validUntil: d(q.validUntil), partnerId: c.id('partners', q.partnerKey)!, status: q.status,
      vatRate: q.vatRate, discountPct: q.discountPct, discountAmount: q.discountAmount, netTotal: t.net, vatTotal: t.vat, grandTotal: t.total,
      hideSerials: q.hideSerials, note: q.note, invoiceId, createdBy: q.createdBy, createdAt: ts(q.createdAt),
    };
  });
  await bulkInsert(tx, 'Quote', quoteRows);
  await bulkInsert(tx, 'QuoteLine', quoteLines);
  c.count('quotes', quoteRows.length);

  // međuskladišnice
  const transfers = await numbered(c, 'transfers', 'TRANSFER', plan.transfers, () => tx.transfer.findMany(where), (r) => Number(r.date.slice(0, 4)));
  await bulkInsert(tx, 'Transfer', transfers.map((t) => ({
        id: t.id, companyId, number: t.number, date: d(t.date)!, fromWarehouseId: c.id('warehouses', t.fromWarehouseKey), toWarehouseId: c.id('warehouses', t.toWarehouseKey)!,
        note: t.note, createdBy: t.createdBy, createdAt: ts(t.createdAt),
  } satisfies Prisma.TransferCreateManyInput)));
  const tItems = transfers.flatMap((t) => t.itemKeys.map((k) => ({ transferId: t.id, itemId: c.id('items', k)! })).filter((x) => x.itemId));
  await bulkInsert(tx, 'TransferItem', tItems, { skipDuplicates: true });
  c.count('transfers', transfers.length);

  // servisni nalozi
  const so = await numbered(c, 'serviceOrders', 'SERVICE', plan.serviceOrders, () => tx.serviceOrder.findMany(where), (r) => Number(r.reportedAt.slice(0, 4)));
  await bulkInsert(tx, 'ServiceOrder', so.map((s) => ({
        id: s.id, companyId, number: s.number, itemId: c.id('items', s.itemKey), serial: s.serial, partnerId: c.id('partners', s.partnerKey),
        invoiceId: c.id('invoices', s.invoiceKey), status: s.status, reportedAt: d(s.reportedAt)!, receivedAt: d(s.receivedAt), closedAt: d(s.closedAt),
        issue: s.issue, diagnosis: s.diagnosis, action: s.action, solution: s.solution, replacementItemId: c.id('items', s.replacementItemKey), cost: s.cost,
        underWarranty: s.underWarranty, publicNote: s.publicNote, note: s.note, timeline: json(s.timeline), createdBy: s.createdBy, createdAt: ts(s.createdAt),
  } satisfies Prisma.ServiceOrderCreateManyInput)));
  c.count('serviceOrders', so.length);
  c.step('quotes+transfers+service', quoteRows.length + transfers.length + so.length);

  // ulazni računi: dobavljač + broj; interni broj u postojećoj firmi iz brojača
  const haveSiRows = c.existing ? await tx.supplierInvoice.findMany({ where: { companyId }, select: { supplierId: true, number: true, eInvoiceId: true } }) : [];
  const haveSi = new Set(haveSiRows.map((s) => `${s.supplierId}|${low(s.number)}`));
  // id eRačuna kod posrednika je jedinstven po firmi
  const haveEId = new Set(haveSiRows.map((s) => s.eInvoiceId).filter(Boolean));
  const siRows: Prisma.SupplierInvoiceCreateManyInput[] = [];
  for (const s of plan.supplierInvoices) {
    const supplierId = c.id('partners', s.supplierKey)!;
    if (haveSi.has(`${supplierId}|${low(s.number)}`)) {
      c.count('supplierInvoices', 0, 1);
      continue;
    }
    const internalNo = c.existing ? await nextDocNumber(tx, companyId, 'SUPPLIER_INVOICE', Number(s.issueDate.slice(0, 4))) : s.internalNo;
    siRows.push({
      id: c.assign('supplierInvoices', s.key), companyId, internalNo, number: s.number, supplierId, issueDate: d(s.issueDate)!, dueDate: d(s.dueDate),
      netAmount: s.netAmount, vatAmount: s.vatAmount, total: s.total, paidDate: d(s.paidDate), category: s.category, note: s.note, createdAt: ts(s.createdAt),
      // stupci ulaznog eRačuna uvijek imaju vrijednost (bulkInsert bi izostavljeni NOT NULL stupac upisao kao NULL)
      source: s.inbound?.source ?? 'MANUAL', status: s.inbound?.status ?? 'ACCEPTED', statusAt: s.inbound?.statusAt ? ts(s.inbound.statusAt) : null,
      statusBy: s.inbound?.statusBy ?? null, rejectReason: s.inbound?.rejectReason ?? null, eInvoiceEnv: s.inbound?.eInvoiceEnv ?? null,
      providerStatus: s.inbound?.providerStatus ?? null,
      eInvoiceId: s.inbound?.eInvoiceId && !haveEId.has(s.inbound.eInvoiceId) ? (haveEId.add(s.inbound.eInvoiceId), s.inbound.eInvoiceId) : null,
    });
  }
  await bulkInsert(tx, 'SupplierInvoice', siRows);
  c.count('supplierInvoices', siRows.length);

  // troškovi (postojeća firma: isti datum, opis i iznos = isti trošak)
  const haveEx = c.existing
    ? new Set((await tx.expense.findMany({ where: { companyId }, select: { date: true, description: true, netAmount: true } })).map((e) => `${e.date.toISOString().slice(0, 10)}|${low(e.description)}|${Number(e.netAmount)}`))
    : new Set<string>();
  const exRows: Prisma.ExpenseCreateManyInput[] = [];
  for (const e of plan.expenses) {
    if (haveEx.has(`${e.date}|${low(e.description)}|${e.netAmount}`)) {
      c.count('expenses', 0, 1);
      continue;
    }
    const receiptId = c.isFresh('receipts', e.receiptKey) ? c.id('receipts', e.receiptKey) : null;
    const supplierInvoiceId = c.isFresh('supplierInvoices', e.supplierInvoiceKey) ? c.id('supplierInvoices', e.supplierInvoiceKey) : null;
    exRows.push({
      id: c.assign('expenses', e.key), companyId, date: d(e.date)!, categoryId: c.id('expenseCategories', e.categoryKey), description: e.description,
      partnerId: c.id('partners', e.partnerKey), netAmount: e.netAmount, vatAmount: e.vatAmount, paid: e.paid, paidDate: d(e.paidDate), frequency: e.frequency,
      recurringUntil: d(e.recurringUntil), overrides: json(e.overrides),
      source: receiptId ? 'RECEIPT' : supplierInvoiceId ? 'SUPPLIER_INVOICE' : e.source === 'RECEIPT' || e.source === 'SUPPLIER_INVOICE' ? 'MANUAL' : e.source,
      receiptId, supplierInvoiceId, note: e.note, createdBy: e.createdBy, createdAt: ts(e.createdAt),
    });
  }
  await bulkInsert(tx, 'Expense', exRows);
  c.count('expenses', exRows.length);
  c.step('supplierInvoices+expenses', siRows.length + exRows.length);

  // prilozi, povijest uređaja, stari dnevnik
  const ENTITY_MAP: Record<string, string> = {
    item: 'items', invoice: 'invoices', contract: 'contracts', service: 'serviceOrders', serviceOrder: 'serviceOrders', expense: 'expenses',
    supplierInvoice: 'supplierInvoices', receipt: 'receipts', transfer: 'transfers', quote: 'quotes', partner: 'partners', order: 'orders', purchaseOrder: 'orders',
  };
  // vrsta i veličina iz sadržaja (plan je već provjeren u backupToPlan; ovo je druga crta obrane)
  const att = plan.attachments
    .filter((a) => isAttachmentEntity(a.entity))
    .map((a) => ({ a, entityId: c.id(ENTITY_MAP[a.entity] ?? a.entity, a.entityKey), data: Buffer.from(a.base64, 'base64') }))
    .map((x) => ({ ...x, check: checkAttachmentBytes(x.data) }))
    .flatMap(({ a, entityId, data, check }) =>
      entityId && 'mime' in check
        ? [{ companyId, entity: a.entity, entityId, fileName: safeFileName(a.fileName, check.mime), mime: check.mime, size: data.byteLength, data, createdBy: a.createdBy, createdAt: ts(a.createdAt) }]
        : [],
    );
  for (const part of chunks(att, 50)) await tx.attachment.createMany({ data: part });
  c.count('attachments', att.length);

  for (const e of plan.itemEvents) {
    const itemId = c.isFresh('items', e.itemKey) ? c.id('items', e.itemKey) : null;
    if (!itemId) continue;
    c.pendingEvents.push({
      id: newId(), companyId, itemId, at: new Date(e.at), type: e.type, message: e.message, refType: e.refType,
      refId: e.refType && e.refKey ? (c.id(ENTITY_MAP[e.refType] ?? e.refType, e.refKey) ?? null) : null, userName: e.userName,
    });
  }
  await bulkInsert(tx, 'ItemEvent', c.pendingEvents);
  c.count('itemEvents', c.pendingEvents.length);

  const audit = plan.audit.map((a) => ({
    id: newId(), companyId, at: new Date(a.at), userName: a.userName, entity: a.entity, entityId: a.entityId ? (c.id(ENTITY_MAP[a.entity] ?? a.entity, a.entityId) ?? null) : null,
    action: a.action, summary: a.summary, diff: a.diff === undefined || a.diff === null ? undefined : json(a.diff),
  }));
  await bulkInsert(tx, 'AuditLog', audit);
  c.count('audit', audit.length);
  c.step('attachments+events+audit', att.length + c.pendingEvents.length + audit.length);
}
