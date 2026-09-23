/**
 * Stara baza → plan: nabava (narudžbenice, primke), međuskladišnice, servis (RMA),
 * ulazni računi, troškovi i stari dnevnik promjena.
 */
import type { ExpenseSource, Frequency, OrderStatus, ServiceStatus } from '@prisma/client';
import type { z } from 'zod';
import type { LegacyCtx } from './legacy-ctx';
import type { legacyAudit, legacyExpense, legacyInbound, legacyOrder, legacyReceipt, legacyRma, legacyTransfer } from './legacy-parse';
import type { Key } from './plan';
import { r2 } from '@/domain/money';

type Rows<T extends z.ZodTypeAny> = Array<z.infer<T>>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const ORDER_STATUS: Record<string, OrderStatus> = { nacrt: 'DRAFT', poslana: 'ORDERED', djelomicno: 'PARTIAL', zaprimljena: 'RECEIVED', otkazana: 'CANCELLED' };
export const RMA_STATUS: Record<string, ServiceStatus> = {
  prijavljeno: 'REPORTED', zaprimljeno: 'RECEIVED', 'u dijagnostici': 'DIAGNOSIS', 'kod dobavljača': 'AT_SUPPLIER', 'kod dobavljaca': 'AT_SUPPLIER',
  popravljeno: 'REPAIRED', zamijenjeno: 'REPLACED', otpisano: 'WRITTEN_OFF',
};
export const FREQUENCY: Record<string, Frequency> = { mjesecno: 'MONTHLY', kvartalno: 'QUARTERLY', polugodisnje: 'SEMIANNUAL', godisnje: 'ANNUAL' };

export function mapOrders(ctx: LegacyCtx, rows: Rows<typeof legacyOrder>) {
  for (const [i, r] of rows.entries()) {
    const where = `Narudžbenica ${r.number || `#${i + 1}`}`;
    const key = r.id ?? ctx.genKey('order');
    const date = ctx.reqDate(where, 'datum', r.date, r.createdAt);
    const status = ORDER_STATUS[r.status || 'nacrt'];
    if (!status) ctx.w.warn('order-status', 'narudžbenica', `${where}: nepoznato stanje „${r.status}" — nacrt.`);
    const lines = r.lines.filter(Boolean).flatMap((l, j) => {
      const modelKey = l.modelId ? ctx.models.get(l.modelId) : undefined;
      if (!modelKey) {
        ctx.w.warn('ref-model', 'veza', `${where}, stavka ${j + 1}: model „${l.modelId ?? ''}" ne postoji — stavka izostavljena.`);
        return [];
      }
      const qty = Math.max(1, Math.round(ctx.num(l.qty, where, 'količina', 1)));
      return [{ modelKey, qty, unitCost: ctx.money(l.cost, where, 'cijena', 0), received: Math.max(0, Math.round(ctx.num(l.received, where, 'zaprimljeno', 0))) }];
    });
    const number = r.number ? ctx.numbers.unique('ORDER', r.number) : ctx.numbers.next('ORDER', Number(date.slice(0, 4)));
    ctx.orders.add(key);
    ctx.plan.orders.push({
      key, number, generatedNumber: !r.number, supplierKey: ctx.partner(r.supplierId, where, 'dobavljač') ?? ctx.supplierPlaceholder(),
      date, expectedDate: ctx.date(r.expectedDate, where, 'očekivano'), status: status ?? 'DRAFT', note: r.note || null,
      createdBy: ctx.user(r.createdBy), createdAt: ctx.ts(r.createdAt), lines,
    });
  }
}

/** Primke; vraća mapu trošak (stari id) → primka. */
export function mapReceipts(ctx: LegacyCtx, rows: Rows<typeof legacyReceipt>): Map<string, Key> {
  const expenseToReceipt = new Map<string, Key>();
  for (const [i, r] of rows.entries()) {
    const where = `Primka ${r.number || `#${i + 1}`}`;
    const key = r.id ?? ctx.genKey('receipt');
    const date = ctx.reqDate(where, 'datum', r.date, r.createdAt);
    const itemKeys: Key[] = [];
    let itemsCost = 0;
    for (const id of new Set(r.itemIds)) {
      const it = ctx.item(id, where);
      if (!it) continue;
      if (it.receiptKey) ctx.w.info('receipt-item-dup', 'primka', `${where}: SN ${it.serial} je već na drugoj primci.`);
      else it.receiptKey = key;
      itemKeys.push(it.key);
      itemsCost += it.cost;
    }
    const linesTotal = r.lines.filter(Boolean).reduce((a, l) => a + ctx.num(l.qty, where, 'količina', 0) * ctx.num(l.cost, where, 'cijena', 0), 0);
    const number = r.number ? ctx.numbers.unique('RECEIPT', r.number) : ctx.numbers.next('RECEIPT', Number(date.slice(0, 4)));
    ctx.receipts.add(key);
    ctx.plan.receipts.push({
      key, number, generatedNumber: !r.number, date,
      supplierKey: ctx.partner(r.supplierId, where, 'dobavljač'),
      orderKey: r.orderId && ctx.orders.has(r.orderId) ? r.orderId : null,
      warehouseKey: ctx.warehouse(r.warehouseId, where) ?? ctx.defaultWarehouse(),
      supplierDocNumber: r.supplierDocNumber || null,
      status: /storn|otkaz/i.test(r.status) ? 'CANCELLED' : 'POSTED',
      total: r2(linesTotal || itemsCost),
      note: r.note || null,
      createdBy: ctx.user(r.createdBy),
      createdAt: ctx.ts(r.createdAt),
    });
    if (r.expenseId) expenseToReceipt.set(r.expenseId, key);
  }
  return expenseToReceipt;
}

export function mapTransfers(ctx: LegacyCtx, rows: Rows<typeof legacyTransfer>) {
  for (const [i, r] of rows.entries()) {
    const where = `Međuskladišnica ${r.number || `#${i + 1}`}`;
    const toKey = ctx.warehouse(r.toWarehouseId ?? r.toId ?? r.to, where);
    if (!toKey) {
      ctx.w.warn('transfer-to', 'međuskladišnica', `${where}: nema odredišnog skladišta — preskočena.`);
      continue;
    }
    const date = ctx.reqDate(where, 'datum', r.date, r.createdAt);
    const itemKeys = [...new Set(r.itemIds)].map((id) => ctx.item(id, where)?.key).filter((k): k is Key => !!k);
    const number = r.number ? ctx.numbers.unique('TRANSFER', r.number) : ctx.numbers.next('TRANSFER', Number(date.slice(0, 4)));
    ctx.plan.transfers.push({
      key: r.id ?? ctx.genKey('transfer'), number, generatedNumber: !r.number, date,
      fromWarehouseKey: ctx.warehouse(r.fromWarehouseId ?? r.fromId ?? r.from, where), toWarehouseKey: toKey,
      note: r.note || null, createdBy: ctx.user(r.createdBy || r.by), createdAt: ctx.ts(r.createdAt), itemKeys,
    });
  }
}

export function mapRma(ctx: LegacyCtx, rows: Rows<typeof legacyRma>) {
  for (const [i, r] of rows.entries()) {
    const where = `Servisni nalog ${r.number || `#${i + 1}`}`;
    const item = ctx.item(r.itemId, where);
    const reportedAt = ctx.reqDate(where, 'prijavljeno', r.reportedDate, r.receivedDate, r.createdAt);
    const closedAt = ctx.date(r.closedDate, where, 'zatvoreno');
    let status = RMA_STATUS[r.status.toLowerCase()];
    if (!status) {
      status = closedAt ? 'REPAIRED' : 'RECEIVED';
      ctx.w.warn('rma-status', 'servis', `${where}: nepoznat status „${r.status}" — ${closedAt ? 'popravljeno' : 'zaprimljeno'}.`);
    }
    const timeline = r.timeline.filter(isObj).map((e) => ({
      at: ctx.ts(e.at ?? e.ts ?? e.date) ?? `${reportedAt}T00:00:00.000Z`,
      status: RMA_STATUS[String(e.status ?? '').toLowerCase()] ?? status,
      by: typeof e.by === 'string' ? e.by : typeof e.user === 'string' ? e.user : null,
      note: typeof e.note === 'string' ? e.note : typeof e.text === 'string' ? e.text : null,
    }));
    if (!timeline.length) timeline.push({ at: ctx.ts(r.createdAt) ?? `${reportedAt}T00:00:00.000Z`, status, by: null, note: 'Uvezeno iz stare verzije' });
    const replacement = r.replacementItemId ? ctx.item(r.replacementItemId, where) : null;
    const number = r.number ? ctx.numbers.unique('SERVICE', r.number) : ctx.numbers.next('SERVICE', Number(reportedAt.slice(0, 4)));
    ctx.plan.serviceOrders.push({
      key: r.id ?? ctx.genKey('rma'), number, generatedNumber: !r.number,
      itemKey: item?.key ?? null, serial: r.serial || item?.serial || null,
      partnerKey: ctx.partner(r.partnerId, where, 'klijent'),
      invoiceKey: r.invoiceId && ctx.invoices.has(r.invoiceId) ? r.invoiceId : null,
      status, reportedAt, receivedAt: ctx.date(r.receivedDate, where, 'zaprimljeno'), closedAt,
      issue: r.issue || 'Nije upisano', diagnosis: r.diagnosis || null, action: r.action || null, solution: r.solution || null,
      replacementItemKey: replacement?.key ?? null, cost: ctx.money(r.cost, where, 'trošak', 0), underWarranty: r.underWarranty !== false,
      publicNote: r.publicNote || null, note: r.note || null, timeline, createdBy: null, createdAt: ctx.ts(r.createdAt),
    });
  }
}

/** Ulazni računi (knjiga URA); vraća mapu trošak (stari id) → ulazni račun. */
export function mapInbound(ctx: LegacyCtx, rows: Rows<typeof legacyInbound>): Map<string, Key> {
  const expenseToInbound = new Map<string, Key>();
  const byOib = new Map<string, Key>();
  const byName = new Map<string, Key>();
  for (const p of ctx.plan.partners) {
    if (p.oib) byOib.set(p.oib, p.key);
    byName.set(p.name.toLowerCase(), p.key);
  }
  const prepared = rows.map((r, i) => ({ r, i, where: `Ulazni račun ${r.number || `#${i + 1}`}` }))
    .map((x) => ({ ...x, issueDate: ctx.reqDate(x.where, 'datum računa', x.r.issueDate, x.r.receivedDate, x.r.createdAt) }))
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate));
  for (const { r, where, issueDate } of prepared) {
    if (/odbij/i.test(r.status)) {
      ctx.w.info('inbound-rejected', 'ulazni račun', `${where}: odbijen kod posrednika — nije uvezen u knjigu URA.`);
      continue;
    }
    let supplierKey = ctx.partners.get(r.partnerId ?? r.supplierId ?? '') ?? (r.supplierOib ? byOib.get(r.supplierOib) : undefined) ?? (r.supplierName ? byName.get(r.supplierName.toLowerCase()) : undefined);
    if (!supplierKey) {
      supplierKey = ctx.genKey('partner');
      const name = r.supplierName || 'Nepoznat dobavljač';
      ctx.plan.partners.push({
        key: supplierKey, name, oib: r.supplierOib || null, vatId: null, address: null, zip: null, city: null, country: 'HR', email: null, phone: null,
        iban: null, contactPerson: null, isCustomer: false, isSupplier: true, excluded: false, paymentTermDays: null, note: 'Stvoren pri uvozu ulaznog računa.',
      });
      ctx.partnerCountry.set(supplierKey, 'HR');
      if (r.supplierOib) byOib.set(r.supplierOib, supplierKey);
      byName.set(name.toLowerCase(), supplierKey);
      ctx.w.info('inbound-supplier', 'ulazni račun', `${where}: dobavljač „${name}" dodan među partnere.`);
    }
    const rate = ctx.num(r.vatRate, where, 'PDV %', 0);
    let net = ctx.money(r.net, where, 'osnovica', null);
    let vat = ctx.money(r.vat, where, 'PDV', null);
    let total = ctx.money(r.total, where, 'ukupno', null);
    if (net === null && total !== null) net = r2(total / (1 + rate / 100));
    net ??= 0;
    vat ??= total !== null ? r2(total - net) : r2((net * rate) / 100);
    total ??= r2(net + vat);
    const key = r.id ?? ctx.genKey('inbound');
    ctx.plan.supplierInvoices.push({
      key, internalNo: ctx.numbers.next('SUPPLIER_INVOICE', Number(issueDate.slice(0, 4))), generatedNumber: true,
      number: r.number || '(bez broja)', supplierKey, issueDate, dueDate: ctx.date(r.dueDate, where, 'dospijeće'),
      netAmount: net, vatAmount: vat, total, paidDate: ctx.date(r.paidDate, where, 'plaćeno'), category: r.category || null,
      note: [r.note, r.rejectReason].filter(Boolean).join(' · ') || null, createdAt: ctx.ts(r.createdAt),
    });
    if (r.expenseId) expenseToInbound.set(r.expenseId, key);
  }
  return expenseToInbound;
}

export function mapExpenses(ctx: LegacyCtx, rows: Rows<typeof legacyExpense>, links: { receipts: Map<string, Key>; inbound: Map<string, Key> }) {
  const usedReceipts = new Set<Key>();
  const usedInbound = new Set<Key>();
  for (const [i, r] of rows.entries()) {
    const where = `Trošak ${r.description || `#${i + 1}`}`;
    const date = ctx.reqDate(where, 'datum', r.date, r.createdAt);
    const catName = r.category || 'Ostalo';
    let categoryKey = ctx.expenseCategories.get(catName.toLowerCase());
    if (!categoryKey) {
      categoryKey = ctx.genKey('expcat');
      ctx.expenseCategories.set(catName.toLowerCase(), categoryKey);
      ctx.plan.expenseCategories.push({ key: categoryKey, name: catName });
    }
    const net = ctx.money(r.amount, where, 'iznos', 0);
    const rate = ctx.num(r.vatRate, where, 'PDV %', 0);
    let frequency: Frequency | null = null;
    let recurringUntil: string | null = null;
    if (isObj(r.recurring) && r.recurring.freq) {
      frequency = FREQUENCY[String(r.recurring.freq)] ?? null;
      if (!frequency) ctx.w.warn('expense-freq', 'trošak', `${where}: nepoznata učestalost „${String(r.recurring.freq)}" — jednokratni trošak.`);
      recurringUntil = ctx.date(r.recurring.until, where, 'ponavlja se do');
    }
    const overrides: Record<string, { amount?: number; skipped?: boolean }> = {};
    for (const [p, v] of Object.entries(r.overrides)) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p) || !isObj(v)) continue;
      const o: { amount?: number; skipped?: boolean } = {};
      if (v.skipped) o.skipped = true;
      if (v.amount !== undefined && v.amount !== null && v.amount !== '') {
        const n = Number(typeof v.amount === 'string' ? v.amount.replace(/\./g, '').replace(',', '.') : v.amount);
        if (Number.isFinite(n)) o.amount = r2(n);
      }
      if (Object.keys(o).length) overrides[p] = o;
    }
    const id = r.id ?? '';
    let receiptKey = links.receipts.get(id) ?? (r.receiptId && ctx.receipts.has(r.receiptId) ? r.receiptId : null);
    if (receiptKey && usedReceipts.has(receiptKey)) receiptKey = null;
    let supplierInvoiceKey = links.inbound.get(id) ?? null;
    if (supplierInvoiceKey && usedInbound.has(supplierInvoiceKey)) supplierInvoiceKey = null;
    if (receiptKey) usedReceipts.add(receiptKey);
    if (supplierInvoiceKey) usedInbound.add(supplierInvoiceKey);
    const source: ExpenseSource = receiptKey ? 'RECEIPT' : supplierInvoiceKey ? 'SUPPLIER_INVOICE' : /otpis/i.test(r.source) ? 'WRITE_OFF' : 'MANUAL';
    const paid = r.paid ?? false;
    ctx.plan.expenses.push({
      key: r.id ?? ctx.genKey('expense'), date, categoryKey, description: r.description || catName, partnerKey: ctx.partner(r.partnerId, where),
      netAmount: net, vatAmount: r2((net * rate) / 100), paid, paidDate: paid ? date : null, frequency, recurringUntil, overrides,
      source, receiptKey, supplierInvoiceKey, note: r.note || null, createdBy: ctx.user(r.createdBy), createdAt: ctx.ts(r.createdAt),
    });
  }
}

export function mapAudit(ctx: LegacyCtx, rows: Rows<typeof legacyAudit>) {
  for (const r of rows) {
    const at = ctx.ts(r.ts);
    if (!at) continue;
    ctx.plan.audit.push({
      at, userName: r.userName || null, entity: r.entity || 'staro', entityId: null, action: r.action || 'izmjena',
      summary: r.summary || '—', diff: { izvor: 'stara verzija', entityId: r.entityId },
    });
  }
}
