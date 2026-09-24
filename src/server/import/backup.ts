import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { plain } from '../plain';
import { isAttachmentEntity } from '../services/attachments';
import { ATTACHMENT_MAX_BYTES, checkAttachmentBytes, safeFileName } from '@/domain/attachments';
import { sanitizeCompanySettings } from '@/domain/company';
import { computeInvoiceTotals, emptyPlan, normalizeItemState, Warnings, type ImportPlan, type PlanAttachment, type PlanCounter } from './plan';

/**
 * Sigurnosna kopija ove aplikacije: cijela firma u vlastitom JSON obliku
 *   { format: 'erp-wms-backup', version: 1, exportedAt, company, users, warehouses, …, notes }
 * Izvoz se šalje kao tok (tablica po tablicu, po 2000 redaka; prilozi po 20
 * jer nose sadržaj), redak po redak, pa ni velika firma ne zauzima memoriju
 * poslužitelja. Vraćanje ide u NOVU firmu: zapisi
 * dobivaju nove id-eve (isti postupak kao uvoz iz stare verzije).
 *
 * Ne izvoze se: lozinke korisnika i sesije, fiskalni certifikat i njegova
 * lozinka, API ključ posrednika, zahtjevi na odobrenju, trag fiskalizacije i inventure.
 */
export const BACKUP_FORMAT = 'erp-wms-backup';
export const BACKUP_VERSION = 1;
const PAGE = 2000;
/** Prilozi nose sadržaj (do 2 MB, u base64 ~2,7 MB) — manja stranica drži memoriju malom. */
const ATTACHMENT_PAGE = 20;

export const BACKUP_NOTES = [
  'Lozinke korisnika, sesije, fiskalni certifikat (i lozinka) i API ključ posrednika nisu u kopiji.',
  'Zahtjevi na odobrenju, trag komunikacije s CIS-om i inventure nisu u kopiji.',
  'Prilozi su uključeni (sadržaj u base64).',
];

type Row = Record<string, unknown>;
type Fetch = ((cursor: string | undefined) => Promise<Row[]>) & { page?: number };

/** Stranica po id-u (kursor) — bez OFFSET-a, brzo i za stotine tisuća redaka. */
const byId = <T extends Row>(q: (args: { take: number; skip: number; cursor?: { id: string }; orderBy: { id: 'asc' } }) => Promise<T[]>, page = PAGE): Fetch =>
  Object.assign((cursor: string | undefined) => q({ take: page, skip: cursor ? 1 : 0, cursor: cursor ? { id: cursor } : undefined, orderBy: { id: 'asc' } }), { page });

function tables(companyId: string): Array<[string, Fetch | (() => Promise<Row[]>)]> {
  const w = { companyId };
  return [
    ['users', () => db.user.findMany({ where: w, select: { id: true, email: true, name: true, role: true, permissions: true, oib: true, active: true }, orderBy: { id: 'asc' } })],
    ['warehouses', () => db.warehouse.findMany({ where: w, orderBy: { id: 'asc' } })],
    ['categories', () => db.category.findMany({ where: w, orderBy: { id: 'asc' } })],
    ['models', () => db.deviceModel.findMany({ where: w, orderBy: { id: 'asc' } })],
    ['statuses', () => db.itemStatus.findMany({ where: w, orderBy: { id: 'asc' } })],
    ['services', () => db.service.findMany({ where: w, orderBy: { id: 'asc' } })],
    ['expenseCategories', () => db.expenseCategory.findMany({ where: w, orderBy: { id: 'asc' } })],
    ['partners', byId((a) => db.partner.findMany({ ...a, where: w }))],
    ['priceAgreements', byId((a) => db.priceAgreement.findMany({ ...a, where: w }))],
    ['contracts', byId((a) => db.contract.findMany({ ...a, where: w }))],
    ['contractItems', byId((a) => db.contractItem.findMany({ ...a, where: { contract: w } }))],
    ['invoices', byId((a) => db.invoice.findMany({ ...a, where: w }))],
    ['invoiceLines', byId((a) => db.invoiceLine.findMany({ ...a, where: { invoice: w } }))],
    ['payments', byId((a) => db.payment.findMany({ ...a, where: { invoice: w } }))],
    ['purchaseOrders', byId((a) => db.purchaseOrder.findMany({ ...a, where: w }))],
    ['purchaseOrderLines', byId((a) => db.purchaseOrderLine.findMany({ ...a, where: { order: w } }))],
    ['receipts', byId((a) => db.goodsReceipt.findMany({ ...a, where: w }))],
    ['items', byId((a) => db.item.findMany({ ...a, where: w }))],
    ['itemEvents', byId((a) => db.itemEvent.findMany({ ...a, where: w }))],
    ['rentOverrides', () => db.rentOverride.findMany({ where: w, orderBy: [{ itemId: 'asc' }, { year: 'asc' }, { month: 'asc' }] })],
    ['quotes', byId((a) => db.quote.findMany({ ...a, where: w }))],
    ['quoteLines', byId((a) => db.quoteLine.findMany({ ...a, where: { quote: w } }))],
    ['transfers', byId((a) => db.transfer.findMany({ ...a, where: w }))],
    ['transferItems', () => db.transferItem.findMany({ where: { transfer: w }, orderBy: [{ transferId: 'asc' }, { itemId: 'asc' }] })],
    ['serviceOrders', byId((a) => db.serviceOrder.findMany({ ...a, where: w }))],
    ['supplierInvoices', byId((a) => db.supplierInvoice.findMany({ ...a, where: w }))],
    ['expenses', byId((a) => db.expense.findMany({ ...a, where: w }))],
    ['attachments', byId((a) => db.attachment.findMany({ ...a, where: w }), ATTACHMENT_PAGE)],
    ['auditLogs', byId((a) => db.auditLog.findMany({ ...a, where: w }))],
    ['counters', () => db.documentCounter.findMany({ where: w, orderBy: [{ series: 'asc' }, { year: 'asc' }] })],
  ];
}

/** Redak → JSON: Decimal → broj, datum → ISO, bajtovi → base64; prazna polja i companyId se izostavljaju (kraća datoteka). */
function rowJson(r: Row): string {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null || k === 'companyId') continue;
    out[k] = v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v instanceof Prisma.Decimal || v instanceof Date ? plain(v) : v;
  }
  return JSON.stringify(out);
}

/** Tok JSON-a cijele firme. */
export async function exportCompanyStream(companyId: string): Promise<ReadableStream<Uint8Array>> {
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId } });
  const { fiscalCert: _c, fiscalCertPassword: _p, eInvoiceApiKey: _k, ...safe } = company;
  const enc = new TextEncoder();
  const list = tables(companyId);
  let started = false;
  let t = 0;
  let cursor: string | undefined;
  let first = true;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          const head = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), app: 'ERP/WMS', notes: BACKUP_NOTES };
          controller.enqueue(enc.encode(`${JSON.stringify(head).slice(0, -1)},"company":${rowJson(safe)}`));
          return;
        }
        if (t >= list.length) {
          controller.enqueue(enc.encode('}\n'));
          controller.close();
          return;
        }
        const [name, fetch] = list[t];
        if (first) controller.enqueue(enc.encode(`,"${name}":[`));
        const rows = await (fetch as Fetch)(cursor);
        const page = (fetch as Fetch).page; // byId prima kursor i zna veličinu stranice
        const lastId = rows.length ? String(rows[rows.length - 1].id) : undefined;
        // redak po redak: nikad se ne gradi jedan niz za cijelu stranicu (prilozi s base64 sadržajem)
        for (let i = 0; i < rows.length; i++) {
          controller.enqueue(enc.encode((first && i === 0 ? '' : ',') + rowJson(rows[i])));
          rows[i] = {};
        }
        if (rows.length) first = false;
        if (page && rows.length === page) {
          cursor = lastId;
          return;
        }
        controller.enqueue(enc.encode(']'));
        t++;
        cursor = undefined;
        first = true;
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/**
 * Približna veličina kopije (bajtovi) — za upozorenje ako bi bila veća od
 * najveće datoteke koja se može vratiti (MAX_UPLOAD_BYTES). Prilozi se broje
 * točno (base64), ostali zapisi prosječnom veličinom retka.
 */
export async function estimateBackupBytes(companyId: string): Promise<number> {
  const w = { companyId };
  const [att, items, events, invoices, lines, audit, other] = await Promise.all([
    db.attachment.aggregate({ where: w, _sum: { size: true } }),
    db.item.count({ where: w }),
    db.itemEvent.count({ where: w }),
    db.invoice.count({ where: w }),
    db.invoiceLine.count({ where: { invoice: w } }),
    db.auditLog.count({ where: w }),
    Promise.all([db.partner.count({ where: w }), db.contract.count({ where: w }), db.expense.count({ where: w })]).then((a) => a.reduce((x, y) => x + y, 0)),
  ]);
  return Math.round(((att._sum.size ?? 0) * 4) / 3) + items * 500 + events * 250 + invoices * 900 + lines * 350 + audit * 350 + other * 400;
}

// ---------------------------------------------------------------- vraćanje

const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (raw: Row, k: string): Row[] => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).filter(isObj) : []);
const s = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));
const n = (v: unknown, fb = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fb);
const nn = (v: unknown) => (v === null || v === undefined || v === '' ? null : n(v));
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const group = (rows: Row[], k: string) => {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const key = String(r[k]);
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(r);
  }
  return m;
};

export function isBackup(raw: unknown): raw is Row {
  return isObj(raw) && raw.format === BACKUP_FORMAT;
}

/** Sigurnosna kopija → plan uvoza (ključevi su id-evi iz kopije). */
export function backupToPlan(raw: Row): ImportPlan {
  if (n(raw.version) > BACKUP_VERSION) throw new Error(`Kopija je iz novije verzije programa (${raw.version}).`);
  const co = isObj(raw.company) ? raw.company : {};
  const plan = emptyPlan({ format: 'erp-wms-backup', label: 'Sigurnosna kopija ove aplikacije', companyName: s(co.name), exportedAt: s(raw.exportedAt), version: n(raw.version) });
  const pick = ['name', 'oib', 'vatId', 'address', 'zip', 'city', 'country', 'iban', 'bank', 'email', 'phone', 'web', 'logo', 'currency', 'vatRegistered', 'vatRate',
    'overdueDays', 'paymentTermDays', 'quoteValidDays', 'defaultMarginPct', 'defaultWarrantyMonths', 'rentFallbackPct', 'invoicePremises', 'invoiceDevice',
    'invoiceSeparator', 'invoiceFooter', 'statusChangeNeedsApproval'] as const;
  const settings = sanitizeCompanySettings(Object.fromEntries(pick.filter((k) => co[k] !== undefined).map((k) => [k, co[k]])));
  plan.company = settings.company;
  const W = (msg: string) => plan.warnings.push({ level: 'info', code: 'backup', entity: 'kopija', message: msg });
  for (const note of settings.notes) new Warnings(plan).warn('company-settings', 'Firma', note);

  plan.users = arr(raw, 'users').map((u) => ({ name: s(u.name) ?? '', email: s(u.email), role: s(u.role) ?? 'SALES', active: u.active !== false }));
  plan.warehouses = arr(raw, 'warehouses').map((r) => ({ key: s(r.id)!, name: s(r.name)!, address: s(r.address), active: r.active !== false, sort: n(r.sort) }));
  plan.categories = arr(raw, 'categories').map((r) => ({ key: s(r.id)!, name: s(r.name)!, sort: n(r.sort) }));
  plan.models = arr(raw, 'models').map((r) => ({
    key: s(r.id)!, categoryKey: s(r.categoryId), brand: s(r.brand), name: s(r.name)!, code: s(r.code), kpd: s(r.kpd), salePrice: nn(r.salePrice), rentPrice: nn(r.rentPrice),
    marginPct: nn(r.marginPct), warrantyMonths: nn(r.warrantyMonths), minStock: n(r.minStock), specs: s(r.specs), active: r.active !== false,
  }));
  plan.statuses = arr(raw, 'statuses').map((r) => ({ key: s(r.id)!, name: s(r.name)!, kind: r.kind as never, color: s(r.color) ?? 'gray', system: !!r.system, sort: n(r.sort) }));
  plan.services = arr(raw, 'services').map((r) => ({ key: s(r.id)!, name: s(r.name)!, unit: s(r.unit) ?? 'kom', price: n(r.price), kpd: s(r.kpd), active: r.active !== false }));
  plan.expenseCategories = arr(raw, 'expenseCategories').map((r) => ({ key: s(r.id)!, name: s(r.name)! }));
  plan.partners = arr(raw, 'partners').map((r) => ({
    key: s(r.id)!, name: s(r.name)!, oib: s(r.oib), vatId: s(r.vatId), address: s(r.address), zip: s(r.zip), city: s(r.city), country: s(r.country) ?? 'HR',
    email: s(r.email), phone: s(r.phone), iban: s(r.iban), contactPerson: s(r.contactPerson), isCustomer: r.isCustomer !== false, isSupplier: !!r.isSupplier,
    excluded: !!r.excluded, paymentTermDays: nn(r.paymentTermDays), note: s(r.note),
  }));
  plan.priceAgreements = arr(raw, 'priceAgreements').map((r) => ({ partnerKey: s(r.partnerId)!, modelKey: s(r.modelId)!, salePrice: nn(r.salePrice), rentPrice: nn(r.rentPrice) }));
  plan.items = arr(raw, 'items').map((r) => ({
    key: s(r.id)!, serial: s(r.serial)!, dupNote: s(r.dupNote), modelKey: s(r.modelId)!, statusKey: s(r.statusId)!, state: r.state as never,
    warehouseKey: s(r.warehouseId), supplierKey: s(r.supplierId), partnerKey: s(r.partnerId), invoiceKey: s(r.invoiceId), receiptKey: s(r.receiptId),
    cost: n(r.cost), salePrice: nn(r.salePrice), rentPrice: nn(r.rentPrice), marginPct: nn(r.marginPct), importDate: day(r.importDate), issueDate: day(r.issueDate),
    warrantyStart: day(r.warrantyStart), warrantyMonths: nn(r.warrantyMonths), outAt: s(r.outAt), outPartnerKey: s(r.outPartnerId), outNote: s(r.outNote),
    writeOffDate: day(r.writeOffDate), writeOffReason: s(r.writeOffReason), note: s(r.note), createdAt: s(r.createdAt),
  }));
  for (const it of plan.items) normalizeItemState(it);

  const lines = group(arr(raw, 'invoiceLines'), 'invoiceId');
  const pays = group(arr(raw, 'payments'), 'invoiceId');
  plan.invoices = arr(raw, 'invoices').map((r) => ({
    key: s(r.id)!, status: r.status as never, kind: r.kind as never, type: r.type as never, seq: nn(r.seq), year: n(r.year), number: s(r.number),
    partnerKey: s(r.partnerId)!, date: day(r.date)!, dueDate: day(r.dueDate), deliveryDate: day(r.deliveryDate), vatRate: n(r.vatRate), taxCategory: s(r.taxCategory) ?? 'S',
    taxExemptReason: s(r.taxExemptReason), discountPct: n(r.discountPct), discountAmount: n(r.discountAmount), charges: Array.isArray(r.charges) ? (r.charges as never) : [],
    advanceAmount: n(r.advanceAmount), stornoed: !!r.stornoed, refInvoiceKey: s(r.refInvoiceId), contractKey: s(r.contractId), period: s(r.period),
    description: s(r.description), note: s(r.note), paymentRef: s(r.paymentRef), paymentMethod: (s(r.paymentMethod) ?? 'TRANSFER') as never,
    eInvoice: isObj(r.eInvoice) ? r.eInvoice : {}, zki: s(r.zki), jir: s(r.jir), fiscalStatus: (s(r.fiscalStatus) ?? 'NOT_REQUIRED') as never, fiscalizedAt: s(r.fiscalizedAt),
    createdBy: s(r.createdBy), issuedBy: s(r.issuedBy), issuedAt: s(r.issuedAt), createdAt: s(r.createdAt),
    lines: (lines.get(String(r.id)) ?? []).sort((a, b) => n(a.sort) - n(b.sort)).map((l) => ({
      kind: l.kind as never, itemKey: s(l.itemId), modelKey: s(l.modelId), serviceKey: s(l.serviceId), description: s(l.description) ?? '', unit: s(l.unit) ?? 'kom',
      kpd: s(l.kpd), qty: n(l.qty, 1), monthly: nn(l.monthly), months: nn(l.months), unitPrice: n(l.unitPrice), discountPct: n(l.discountPct), cost: n(l.cost),
      warrantyMonths: nn(l.warrantyMonths), agreedPrice: !!l.agreedPrice,
    })),
    payments: (pays.get(String(r.id)) ?? []).map((p) => ({ date: day(p.date)!, amount: n(p.amount), method: s(p.method), note: s(p.note), createdBy: s(p.createdBy) })),
  }));
  computeInvoiceTotals(plan.invoices);

  const cItems = group(arr(raw, 'contractItems'), 'contractId');
  plan.contracts = arr(raw, 'contracts').map((r) => ({
    key: s(r.id)!, number: s(r.number)!, partnerKey: s(r.partnerId)!, status: r.status as never, startDate: day(r.startDate)!, endDate: day(r.endDate),
    firstBillingDate: day(r.firstBillingDate), billingDay: nn(r.billingDay), billing: r.billing as never, billingMode: r.billingMode as never,
    seasonFrom: nn(r.seasonFrom), seasonTo: nn(r.seasonTo), terminatedAt: day(r.terminatedAt), note: s(r.note), createdBy: s(r.createdBy), createdAt: s(r.createdAt),
    items: (cItems.get(String(r.id)) ?? []).map((ci) => ({
      itemKey: s(ci.itemId)!, monthly: n(ci.monthly), plan: Array.isArray(ci.plan) ? (ci.plan as never) : [], status: (s(ci.status) as never) ?? null,
      skipped: Array.isArray(ci.skipped) ? (ci.skipped as string[]) : [],
      paused: Array.isArray(ci.paused) ? (ci.paused as string[]) : [],
    })),
  }));
  plan.rentOverrides = arr(raw, 'rentOverrides').map((r) => ({ itemKey: s(r.itemId)!, year: n(r.year), month: n(r.month), amount: n(r.amount) }));

  const qLines = group(arr(raw, 'quoteLines'), 'quoteId');
  plan.quotes = arr(raw, 'quotes').map((r) => ({
    key: s(r.id)!, number: s(r.number)!, date: day(r.date)!, validUntil: day(r.validUntil), partnerKey: s(r.partnerId)!, status: r.status as never, vatRate: n(r.vatRate),
    discountPct: n(r.discountPct), discountAmount: n(r.discountAmount), hideSerials: !!r.hideSerials, note: s(r.note), invoiceKey: s(r.invoiceId),
    createdBy: s(r.createdBy), createdAt: s(r.createdAt),
    lines: (qLines.get(String(r.id)) ?? []).sort((a, b) => n(a.sort) - n(b.sort)).map((l) => ({
      kind: l.kind as never, itemKey: s(l.itemId), modelKey: s(l.modelId), serviceKey: s(l.serviceId), description: s(l.description) ?? '', unit: s(l.unit) ?? 'kom',
      qty: n(l.qty, 1), unitPrice: n(l.unitPrice), discountPct: n(l.discountPct),
    })),
  }));
  const oLines = group(arr(raw, 'purchaseOrderLines'), 'orderId');
  plan.orders = arr(raw, 'purchaseOrders').map((r) => ({
    key: s(r.id)!, number: s(r.number)!, supplierKey: s(r.supplierId)!, date: day(r.date)!, expectedDate: day(r.expectedDate), status: r.status as never, note: s(r.note),
    createdBy: s(r.createdBy), createdAt: s(r.createdAt),
    lines: (oLines.get(String(r.id)) ?? []).map((l) => ({ modelKey: s(l.modelId)!, qty: n(l.qty), unitCost: n(l.unitCost), received: n(l.received) })),
  }));
  plan.receipts = arr(raw, 'receipts').map((r) => ({
    key: s(r.id)!, number: s(r.number)!, date: day(r.date)!, supplierKey: s(r.supplierId), orderKey: s(r.orderId), warehouseKey: s(r.warehouseId)!,
    supplierDocNumber: s(r.supplierDocNumber), status: r.status as never, total: n(r.total), note: s(r.note), createdBy: s(r.createdBy), createdAt: s(r.createdAt),
  }));
  const tItems = group(arr(raw, 'transferItems'), 'transferId');
  plan.transfers = arr(raw, 'transfers').map((r) => ({
    key: s(r.id)!, number: s(r.number)!, date: day(r.date)!, fromWarehouseKey: s(r.fromWarehouseId), toWarehouseKey: s(r.toWarehouseId)!, note: s(r.note),
    createdBy: s(r.createdBy), createdAt: s(r.createdAt), itemKeys: (tItems.get(String(r.id)) ?? []).map((x) => s(x.itemId)!),
  }));
  plan.serviceOrders = arr(raw, 'serviceOrders').map((r) => ({
    key: s(r.id)!, number: s(r.number)!, itemKey: s(r.itemId), serial: s(r.serial), partnerKey: s(r.partnerId), invoiceKey: s(r.invoiceId), status: r.status as never,
    reportedAt: day(r.reportedAt)!, receivedAt: day(r.receivedAt), closedAt: day(r.closedAt), issue: s(r.issue) ?? '', diagnosis: s(r.diagnosis), action: s(r.action),
    solution: s(r.solution), replacementItemKey: s(r.replacementItemId), cost: n(r.cost), underWarranty: r.underWarranty !== false, publicNote: s(r.publicNote),
    note: s(r.note), timeline: remapTimeline(r.timeline), createdBy: s(r.createdBy), createdAt: s(r.createdAt),
  }));
  plan.supplierInvoices = arr(raw, 'supplierInvoices').map((r) => ({
    key: s(r.id)!, internalNo: s(r.internalNo)!, number: s(r.number) ?? '', supplierKey: s(r.supplierId)!, issueDate: day(r.issueDate)!, dueDate: day(r.dueDate),
    netAmount: n(r.netAmount), vatAmount: n(r.vatAmount), total: n(r.total), paidDate: day(r.paidDate), category: s(r.category), note: s(r.note), createdAt: s(r.createdAt),
    inbound: {
      source: s(r.source) === 'EINVOICE' ? 'EINVOICE' : 'MANUAL',
      status: s(r.status) === 'RECEIVED' || s(r.status) === 'REJECTED' ? (s(r.status) as 'RECEIVED' | 'REJECTED') : 'ACCEPTED',
      statusAt: s(r.statusAt), statusBy: s(r.statusBy), rejectReason: s(r.rejectReason),
      eInvoiceId: s(r.eInvoiceId), eInvoiceEnv: s(r.eInvoiceEnv), providerStatus: s(r.providerStatus),
    },
  }));
  plan.expenses = arr(raw, 'expenses').map((r) => ({
    key: s(r.id)!, date: day(r.date)!, categoryKey: s(r.categoryId), description: s(r.description) ?? '', partnerKey: s(r.partnerId), netAmount: n(r.netAmount),
    vatAmount: n(r.vatAmount), paid: !!r.paid, paidDate: day(r.paidDate), frequency: (s(r.frequency) as never) ?? null, recurringUntil: day(r.recurringUntil),
    overrides: isObj(r.overrides) ? (r.overrides as never) : {}, source: (s(r.source) ?? 'MANUAL') as never, receiptKey: s(r.receiptId),
    supplierInvoiceKey: s(r.supplierInvoiceId), note: s(r.note), createdBy: s(r.createdBy), createdAt: s(r.createdAt),
  }));
  plan.itemEvents = arr(raw, 'itemEvents').map((r) => ({
    itemKey: s(r.itemId)!, at: s(r.at)!, type: s(r.type) ?? 'EDIT', message: s(r.message) ?? '', refType: s(r.refType), refKey: s(r.refId), userName: s(r.userName),
  }));
  plan.attachments = backupAttachments(arr(raw, 'attachments'), new Warnings(plan));
  plan.audit = arr(raw, 'auditLogs').map((r) => ({
    at: s(r.at)!, userName: s(r.userName), entity: s(r.entity) ?? 'staro', entityId: s(r.entityId), action: s(r.action) ?? '', summary: s(r.summary) ?? '', diff: r.diff ?? undefined,
  }));
  plan.counters = arr(raw, 'counters').map((r) => ({ series: r.series as PlanCounter['series'], year: n(r.year), last: n(r.last) }));

  if (plan.users.length) W(`Korisnici iz kopije (${plan.users.length}) nisu vraćeni — u novoj firmi dodajte ih u Postavke → Korisnici.`);
  for (const note of Array.isArray(raw.notes) ? raw.notes : []) if (typeof note === 'string') W(note);
  return plan;
}

/**
 * Prilozi iz kopije: datoteka je ulaz izvana, pa se `mime`, `size` i `entity`
 * iz nje ne preuzimaju — sadržaj se dekodira i provjeri kao pri slanju
 * (vrsta po prvim bajtovima, veličina), vrsta zapisa mora biti poznata, a
 * naziv se čisti. Neispravni se preskaču uz upozorenje.
 */
export function backupAttachments(rows: Row[], w: Warnings): PlanAttachment[] {
  const out: PlanAttachment[] = [];
  // base64 duljina najvećeg dopuštenog priloga (+ razmaci/prijelomi koje dekoder preskače)
  const maxB64 = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 + 1024;
  for (const r of rows) {
    const label = s(r.fileName) ?? s(r.id) ?? 'prilog';
    const entity = s(r.entity) ?? '';
    const entityKey = s(r.entityId);
    let error: string | null = null;
    let bytes: Buffer | null = null;
    if (!isAttachmentEntity(entity) || !entityKey) error = `nepoznata vrsta zapisa „${entity}"`;
    else if (typeof r.data !== 'string' || !r.data) error = 'nema sadržaja';
    else if (r.data.length > maxB64) error = `veći od ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`;
    else bytes = Buffer.from(r.data, 'base64');
    const check = bytes ? checkAttachmentBytes(bytes) : null;
    if (check && 'error' in check) error = check.error;
    if (error || !bytes || !check || !('mime' in check)) {
      w.warn('attachment-invalid', 'Prilozi', `Prilog „${label}" nije vraćen: ${error ?? 'neispravan sadržaj'}.`);
      continue;
    }
    out.push({
      entity, entityKey: entityKey!, fileName: safeFileName(s(r.fileName), check.mime), mime: check.mime, size: bytes.byteLength,
      base64: bytes.toString('base64'), createdBy: s(r.createdBy), createdAt: s(r.createdAt),
    });
  }
  return out;
}

/** Tijek servisnog naloga čuva prethodno stanje uređaja (id-eve) — oni se u novoj firmi ne mogu razriješiti, pa se uklanjaju. */
function remapTimeline(v: unknown): unknown[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((e) => {
    const { prev: _prev, ...rest } = e as Row & { prev?: unknown };
    return rest;
  });
}


