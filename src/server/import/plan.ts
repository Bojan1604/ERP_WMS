/**
 * Plan uvoza — normalizirani oblik podataka između izvora (stara verzija, sigurnosna
 * kopija ove aplikacije) i upisa u bazu (run.ts). Zapisi se međusobno vežu
 * ključevima (`key`) iz izvora; stvarni id-evi nastaju tek pri upisu.
 *
 * Čista logika (bez baze): tipovi, skupljanje upozorenja, zbrojevi računa i
 * brojači dokumenata. Zbrojevi računa računaju se istom formulom kao
 * `recalcInvoice` (domain/invoice), pa su spremljeni iznosi dosljedni.
 */
import type {
  Billing, BillingMode, ContractStatus, ExpenseSource, Frequency, InvoiceKind, InvoiceStatus, InvoiceType, LineKind,
  OrderStatus, PaymentMethod, QuoteStatus, ReceiptStatus, Series, ServiceStatus, StatusKind,
} from '@prisma/client';
import { documentTotals, lineShareOfNet, openAmount, formatDocNumber, type ChargeInput } from '@/domain/invoice';
import { r2 } from '@/domain/money';
import type { PlanPeriodInput } from '@/domain/billing';

export type Key = string;
type D = string | null; // datum YYYY-MM-DD

export interface PlanCompany {
  name?: string; oib?: string | null; vatId?: string | null; address?: string | null; zip?: string | null; city?: string | null;
  country?: string; iban?: string | null; bank?: string | null; email?: string | null; phone?: string | null; web?: string | null;
  logo?: string | null; currency?: string; vatRegistered?: boolean; vatRate?: number; overdueDays?: number; paymentTermDays?: number;
  quoteValidDays?: number; defaultMarginPct?: number; defaultWarrantyMonths?: number; rentFallbackPct?: number;
  invoicePremises?: string; invoiceDevice?: string; invoiceSeparator?: string; invoiceFooter?: string | null;
  statusChangeNeedsApproval?: boolean;
}

export interface PlanWarehouse { key: Key; name: string; address: string | null; active: boolean; sort: number }
export interface PlanCategory { key: Key; name: string; sort: number }
export interface PlanModel {
  key: Key; categoryKey: Key | null; brand: string | null; name: string; code: string | null; kpd: string | null;
  salePrice: number | null; rentPrice: number | null; marginPct: number | null; warrantyMonths: number | null; minStock: number;
  specs: string | null; active: boolean;
  /** Zadane specifikacije za nove uređaje modela (procesor, ekran, OS). */
  cpu?: string | null; screen?: string | null; os?: string | null;
}
export interface PlanStatus { key: Key; name: string; kind: StatusKind; color: string; system: boolean; sort: number }
export interface PlanService { key: Key; name: string; unit: string; price: number; kpd: string | null; active: boolean }
export interface PlanExpenseCategory { key: Key; name: string }
export interface PlanPartner {
  key: Key; name: string; oib: string | null; vatId: string | null; address: string | null; zip: string | null; city: string | null;
  country: string; email: string | null; phone: string | null; iban: string | null; contactPerson: string | null;
  isCustomer: boolean; isSupplier: boolean; excluded: boolean; paymentTermDays: number | null; note: string | null;
}
export interface PlanPriceAgreement { partnerKey: Key; modelKey: Key; salePrice: number | null; rentPrice: number | null }

export interface PlanItem {
  key: Key; serial: string; dupNote: string | null; modelKey: Key; statusKey: Key; state: StatusKind;
  warehouseKey: Key | null; supplierKey: Key | null; partnerKey: Key | null; invoiceKey: Key | null; receiptKey: Key | null;
  cost: number; salePrice: number | null; rentPrice: number | null; marginPct: number | null;
  importDate: D; issueDate: D; warrantyStart: D; warrantyMonths: number | null;
  outAt: string | null; outPartnerKey: Key | null; outNote: string | null;
  writeOffDate: D; writeOffReason: string | null; note: string | null; createdAt: string | null;
  /** Kategorija po komadu (null = kategorija modela) i specifikacije po komadu. */
  categoryKey?: Key | null; cpu?: string | null; screen?: string | null; os?: string | null;
}

export interface PlanLine {
  kind: LineKind; itemKey: Key | null; modelKey: Key | null; serviceKey: Key | null; description: string; unit: string;
  kpd: string | null; qty: number; monthly: number | null; months: number | null; unitPrice: number; discountPct: number;
  cost: number; warrantyMonths: number | null; agreedPrice: boolean;
}
export interface PlanPayment { date: string; amount: number; method: string | null; note: string | null; createdBy: string | null }
export interface PlanInvoice {
  key: Key; status: InvoiceStatus; kind: InvoiceKind; type: InvoiceType; seq: number | null; year: number; number: string | null;
  partnerKey: Key; date: string; dueDate: D; deliveryDate: D; vatRate: number; taxCategory: string; taxExemptReason: string | null;
  discountPct: number; discountAmount: number; charges: ChargeInput[]; advanceAmount: number; stornoed: boolean;
  refInvoiceKey: Key | null; contractKey: Key | null; period: string | null; description: string | null; note: string | null;
  paymentRef: string | null; paymentMethod: PaymentMethod; eInvoice: Record<string, unknown>;
  zki?: string | null; jir?: string | null; fiscalStatus?: 'NOT_REQUIRED' | 'PENDING' | 'SENT' | 'FAILED'; fiscalizedAt?: string | null;
  createdBy: string | null; issuedBy: string | null; issuedAt: string | null; createdAt: string | null;
  lines: PlanLine[]; payments: PlanPayment[];
  totals?: InvoiceTotals;
}
export interface InvoiceTotals {
  netTotal: number; vatTotal: number; chargesTotal: number; grandTotal: number; paidTotal: number; creditedTotal: number;
  openAmount: number; costTotal: number; paidDate: string | null; lineNets: number[];
}

export interface PlanContractItem { itemKey: Key; monthly: number; plan: PlanPeriodInput[]; status: ContractStatus | null; skipped: string[]; paused?: string[] }
export interface PlanContract {
  key: Key; number: string; generatedNumber?: boolean; partnerKey: Key; status: ContractStatus; startDate: string; endDate: D;
  firstBillingDate: D; billingDay: number | null; billing: Billing; billingMode: BillingMode; seasonFrom: number | null; seasonTo: number | null;
  terminatedAt: D; note: string | null; createdBy: string | null; createdAt: string | null; items: PlanContractItem[];
}
export interface PlanRentOverride { itemKey: Key; year: number; month: number; amount: number }

export interface PlanQuoteLine {
  kind: LineKind; itemKey: Key | null; modelKey: Key | null; serviceKey: Key | null; description: string; unit: string;
  qty: number; unitPrice: number; discountPct: number;
}
export interface PlanQuote {
  key: Key; number: string; generatedNumber?: boolean; date: string; validUntil: D; partnerKey: Key; status: QuoteStatus; vatRate: number;
  discountPct: number; discountAmount: number; hideSerials: boolean; note: string | null; invoiceKey: Key | null;
  createdBy: string | null; createdAt: string | null; lines: PlanQuoteLine[];
}
export interface PlanOrder {
  key: Key; number: string; generatedNumber?: boolean; supplierKey: Key; date: string; expectedDate: D; status: OrderStatus;
  note: string | null; createdBy: string | null; createdAt: string | null;
  lines: Array<{ modelKey: Key; qty: number; unitCost: number; received: number }>;
}
export interface PlanReceipt {
  key: Key; number: string; generatedNumber?: boolean; date: string; supplierKey: Key | null; orderKey: Key | null; warehouseKey: Key;
  supplierDocNumber: string | null; status: ReceiptStatus; total: number; note: string | null; createdBy: string | null; createdAt: string | null;
}
export interface PlanTransfer {
  key: Key; number: string; generatedNumber?: boolean; date: string; fromWarehouseKey: Key | null; toWarehouseKey: Key;
  note: string | null; createdBy: string | null; createdAt: string | null; itemKeys: Key[];
}
export interface PlanServiceOrder {
  key: Key; number: string; generatedNumber?: boolean; itemKey: Key | null; serial: string | null; partnerKey: Key | null; invoiceKey: Key | null;
  status: ServiceStatus; reportedAt: string; receivedAt: D; closedAt: D; issue: string; diagnosis: string | null; action: string | null;
  solution: string | null; replacementItemKey: Key | null; cost: number; underWarranty: boolean; publicNote: string | null; note: string | null;
  timeline: unknown[]; createdBy: string | null; createdAt: string | null;
}
export interface PlanSupplierInvoice {
  key: Key; internalNo: string; generatedNumber?: boolean; number: string; supplierKey: Key; issueDate: string; dueDate: D;
  netAmount: number; vatAmount: number; total: number; paidDate: D; category: string | null; note: string | null; createdAt: string | null;
  /** Fiskalizacija 2.0 (sigurnosna kopija ovog programa); izostavljeno = ručni, prihvaćen. */
  inbound?: {
    source: 'MANUAL' | 'EINVOICE'; status: 'RECEIVED' | 'ACCEPTED' | 'REJECTED'; statusAt: string | null; statusBy: string | null; rejectReason: string | null;
    eInvoiceId: string | null; eInvoiceEnv: string | null; providerStatus: string | null;
  };
}
export interface PlanExpense {
  key: Key; date: string; categoryKey: Key | null; description: string; partnerKey: Key | null; netAmount: number; vatAmount: number;
  paid: boolean; paidDate: D; frequency: Frequency | null; recurringUntil: D; overrides: Record<string, { amount?: number; skipped?: boolean }>;
  source: ExpenseSource; receiptKey: Key | null; supplierInvoiceKey: Key | null; note: string | null; createdBy: string | null; createdAt: string | null;
}
export interface PlanAudit { at: string; userName: string | null; entity: string; entityId: string | null; action: string; summary: string; diff?: unknown }
export interface PlanItemEvent { itemKey: Key; at: string; type: string; message: string; refType: string | null; refKey: Key | null; userName: string | null }
/** Paket (Marže → Paketi): skupina uređaja s cijenom paketa. */
export interface PlanPackage { key: Key; name: string; price: number | null; note: string | null; itemKeys: Key[]; createdAt: string | null }
export interface PlanAttachment { entity: string; entityKey: Key; fileName: string; mime: string; size: number; base64: string; createdBy: string | null; createdAt: string | null; public?: boolean }
export interface PlanUser { name: string; email: string | null; role: string; active: boolean; note?: string }
export interface PlanCounter { series: Series; year: number; last: number }
/** Dnevnik poslane e-pošte (sigurnosna kopija ovog programa). */
export interface PlanEmailLog {
  kind: string; entityKey: Key | null; to: string; cc: string | null; subject: string; status: 'SENT' | 'FAILED'; error: string | null;
  messageId: string | null; sentBy: string | null; at: string;
}
/** Korisnik portala za klijente — s bcrypt sažetkom lozinke, da se nakon vraćanja može prijaviti. */
export interface PlanPortalUser { partnerKey: Key; email: string; name: string | null; passwordHash: string; active: boolean; lastLoginAt: string | null; createdAt: string | null }

export type SourceFormat = 'legacy-db' | 'legacy-wrapped' | 'legacy-backup' | 'legacy-split' | 'erp-wms-backup';

export interface PlanWarning { level: 'error' | 'warn' | 'info'; code: string; entity: string; message: string }

export interface ImportPlan {
  source: { format: SourceFormat; label: string; companyName: string | null; exportedAt: string | null; version: number | null };
  company: PlanCompany;
  warehouses: PlanWarehouse[];
  categories: PlanCategory[];
  models: PlanModel[];
  statuses: PlanStatus[];
  services: PlanService[];
  expenseCategories: PlanExpenseCategory[];
  partners: PlanPartner[];
  priceAgreements: PlanPriceAgreement[];
  items: PlanItem[];
  invoices: PlanInvoice[];
  contracts: PlanContract[];
  rentOverrides: PlanRentOverride[];
  quotes: PlanQuote[];
  orders: PlanOrder[];
  receipts: PlanReceipt[];
  transfers: PlanTransfer[];
  serviceOrders: PlanServiceOrder[];
  supplierInvoices: PlanSupplierInvoice[];
  expenses: PlanExpense[];
  audit: PlanAudit[];
  itemEvents: PlanItemEvent[];
  attachments: PlanAttachment[];
  users: PlanUser[];
  counters: PlanCounter[];
  /** Samo sigurnosna kopija ovog programa (stara verzija ih nema). */
  emailLogs?: PlanEmailLog[];
  portalUsers?: PlanPortalUser[];
  packages?: PlanPackage[];
  warnings: PlanWarning[];
  /** Broj upozorenja po šifri (i onih koja nisu zapamćena zbog ograničenja). */
  warningCounts: Record<string, number>;
}

export function emptyPlan(source: ImportPlan['source']): ImportPlan {
  return {
    source, company: {}, warehouses: [], categories: [], models: [], statuses: [], services: [], expenseCategories: [], partners: [],
    priceAgreements: [], items: [], invoices: [], contracts: [], rentOverrides: [], quotes: [], orders: [], receipts: [], transfers: [],
    serviceOrders: [], supplierInvoices: [], expenses: [], audit: [], itemEvents: [], attachments: [], users: [], counters: [],
    warnings: [], warningCounts: {},
  };
}

// ---------------------------------------------------------------- upozorenja

/** Najviše toliko upozorenja se pamti; ostala se samo broje po šifri. */
export const MAX_WARNINGS = 5000;

export class Warnings {
  constructor(private readonly plan: ImportPlan) {}
  add(level: PlanWarning['level'], code: string, entity: string, message: string) {
    this.plan.warningCounts[code] = (this.plan.warningCounts[code] ?? 0) + 1;
    if (this.plan.warnings.length < MAX_WARNINGS) this.plan.warnings.push({ level, code, entity, message });
  }
  warn(code: string, entity: string, message: string) { this.add('warn', code, entity, message); }
  info(code: string, entity: string, message: string) { this.add('info', code, entity, message); }
  error(code: string, entity: string, message: string) { this.add('error', code, entity, message); }
}

// ---------------------------------------------------------------- brojevi i nazivi

export const ENTITY_LABEL: Record<string, string> = {
  warehouses: 'Skladišta', categories: 'Kategorije', models: 'Modeli', statuses: 'Statusi', services: 'Usluge',
  expenseCategories: 'Kategorije troškova', partners: 'Partneri', priceAgreements: 'Dogovorene cijene', items: 'Uređaji',
  invoices: 'Računi', invoiceLines: 'Stavke računa', payments: 'Uplate', contracts: 'Ugovori', contractItems: 'Uređaji na ugovorima',
  rentOverrides: 'Ručni upisi najma', quotes: 'Ponude', orders: 'Narudžbenice', receipts: 'Primke', transfers: 'Međuskladišnice',
  serviceOrders: 'Servisni nalozi', supplierInvoices: 'Ulazni računi', expenses: 'Troškovi', audit: 'Dnevnik (stari zapisi)',
  itemEvents: 'Povijest uređaja', attachments: 'Prilozi', users: 'Korisnici (samo popis)',
  emailLogs: 'Dnevnik e-pošte', portalUsers: 'Korisnici portala', packages: 'Paketi',
};

export function planCounts(p: ImportPlan): Record<string, number> {
  return {
    warehouses: p.warehouses.length, categories: p.categories.length, models: p.models.length, statuses: p.statuses.length,
    services: p.services.length, expenseCategories: p.expenseCategories.length, partners: p.partners.length,
    priceAgreements: p.priceAgreements.length, items: p.items.length, invoices: p.invoices.length,
    invoiceLines: p.invoices.reduce((a, i) => a + i.lines.length, 0), payments: p.invoices.reduce((a, i) => a + i.payments.length, 0),
    contracts: p.contracts.length, contractItems: p.contracts.reduce((a, c) => a + c.items.length, 0), rentOverrides: p.rentOverrides.length,
    quotes: p.quotes.length, orders: p.orders.length, receipts: p.receipts.length, transfers: p.transfers.length,
    serviceOrders: p.serviceOrders.length, supplierInvoices: p.supplierInvoices.length, expenses: p.expenses.length,
    audit: p.audit.length, itemEvents: p.itemEvents.length, attachments: p.attachments.length, users: p.users.length,
    emailLogs: p.emailLogs?.length ?? 0, portalUsers: p.portalUsers?.length ?? 0, packages: p.packages?.length ?? 0,
  };
}

/** Prefiksi brojeva dokumenata — isti kao u server/numbering.ts. */
export const DOC_PREFIX: Record<Exclude<Series, 'INVOICE'>, string> = {
  QUOTE: 'PON', PROFORMA: 'PRED', CONTRACT: 'UG', ORDER: 'NAR', RECEIPT: 'PRI', TRANSFER: 'MSK', SERVICE: 'RMA', SUPPLIER_INVOICE: 'URA', STOCKTAKE: 'INV',
};

/** „UG-2024-003", „RMA-2026-0012" → { year, seq }; drugi oblici → null. */
export function docNumberParts(number: string | null | undefined): { year: number; seq: number } | null {
  const m = /^[A-Za-zČĆŠŽĐčćšžđ]+[-/ ]?(\d{4})[-/ ](\d+)$/.exec(String(number ?? '').trim());
  return m ? { year: Number(m[1]), seq: Number(m[2]) } : null;
}

/**
 * Brojevi dokumenata: dodjela brojeva zapisima koji ga nemaju i brojači
 * (serija, godina) podignuti na najveći uvezeni redni broj — nova numeracija
 * nastavlja iza uvezene.
 */
export class DocNumbers {
  private readonly max = new Map<string, number>();
  private readonly used = new Map<Series, Set<string>>();

  seen(series: Series, year: number, seq: number) {
    const k = `${series}|${year}`;
    if (seq > (this.max.get(k) ?? 0)) this.max.set(k, seq);
  }
  /** Zapamti broj (za otkrivanje duplikata); vraća false ako je već zauzet. */
  claim(series: Series, number: string): boolean {
    const set = this.used.get(series) ?? new Set<string>();
    this.used.set(series, set);
    const n = number.trim().toLowerCase();
    if (set.has(n)) return false;
    set.add(n);
    const parts = docNumberParts(number);
    if (parts) this.seen(series, parts.year, parts.seq);
    return true;
  }
  /** Novi broj u obliku ove aplikacije (PON-2026-0001…). */
  next(series: Exclude<Series, 'INVOICE'>, year: number): string {
    for (;;) {
      const seq = (this.max.get(`${series}|${year}`) ?? 0) + 1;
      const number = formatDocNumber(DOC_PREFIX[series], year, seq);
      this.seen(series, year, seq);
      if (this.claim(series, number)) return number;
    }
  }
  /** Jedinstven broj: izvorni ako je slobodan, inače s nastavkom „ (2)". */
  unique(series: Series, number: string): string {
    if (this.claim(series, number)) return number;
    for (let i = 2; ; i++) {
      const n = `${number} (${i})`;
      if (this.claim(series, n)) return n;
    }
  }
  counters(): PlanCounter[] {
    return [...this.max.entries()].map(([k, last]) => {
      const [series, year] = k.split('|');
      return { series: series as Series, year: Number(year), last };
    });
  }
}

// ---------------------------------------------------------------- zbrojevi računa

/**
 * Zbrojevi svih računa plana — ista pravila kao `recalcInvoice`: stavke →
 * documentTotals, uplate, knjižna odobrenja na izvorni račun, otvoreni iznos,
 * nabavna vrijednost i datum plaćanja.
 */
export function computeInvoiceTotals(invoices: PlanInvoice[]) {
  const t = new Map<Key, ReturnType<typeof documentTotals>>();
  for (const inv of invoices) {
    t.set(inv.key, documentTotals({
      lines: inv.lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct })),
      vatRate: inv.vatRate,
      discountPct: inv.discountPct,
      discountAmount: inv.discountAmount,
      charges: inv.charges,
    }));
  }
  const credited = new Map<Key, number>();
  for (const inv of invoices) {
    if (inv.kind === 'CREDIT_NOTE' && inv.status === 'ISSUED' && inv.refInvoiceKey) {
      credited.set(inv.refInvoiceKey, r2((credited.get(inv.refInvoiceKey) ?? 0) + Math.abs(t.get(inv.key)!.total)));
    }
  }
  for (const inv of invoices) {
    const tt = t.get(inv.key)!;
    inv.payments.sort((a, b) => a.date.localeCompare(b.date));
    const paid = r2(inv.payments.reduce((a, p) => a + p.amount, 0));
    const cred = credited.get(inv.key) ?? 0;
    const open = openAmount({ kind: inv.kind, stornoed: inv.stornoed, total: r2(tt.total - cred), advance: inv.advanceAmount, paid });
    const settled = inv.status === 'ISSUED' && open <= 0.005 && (inv.kind === 'INVOICE' || inv.kind === 'ADVANCE') && !inv.stornoed && tt.total > 0;
    inv.totals = {
      netTotal: tt.net, vatTotal: tt.vat, chargesTotal: tt.charges, grandTotal: tt.total, paidTotal: paid, creditedTotal: cred,
      openAmount: inv.status === 'ISSUED' ? open : 0,
      costTotal: r2(inv.lines.reduce((a, l) => a + l.cost, 0)),
      paidDate: settled ? (inv.payments.at(-1)?.date ?? inv.date) : null,
      lineNets: tt.lineNets,
    };
  }
  return t;
}

/** Ostvarena prodajna cijena uređaja s računa (udio u osnovici nakon popusta) — kao pri izdavanju. */
export function saleShares(inv: PlanInvoice): Map<Key, number> {
  const out = new Map<Key, number>();
  const tt = documentTotals({
    lines: inv.lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct })),
    vatRate: inv.vatRate, discountPct: inv.discountPct, discountAmount: inv.discountAmount,
  });
  inv.lines.forEach((l, i) => {
    if (l.kind === 'DEVICE' && l.itemKey) out.set(l.itemKey, lineShareOfNet(tt, i));
  });
  return out;
}

/**
 * Pravila stanja uređaja (kao `changeItemStatus`): uređaj na skladištu ne
 * pripada nikome, trag izlaza postoji samo dok je „izašao", prodan i
 * iznajmljen uređaj nije na skladištu.
 */
/** Specifikacija iz stare baze (procesor, ekran, OS): prazno i crtica = nema. */
export function cleanSpec(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t && t !== '—' && t !== '-' ? t.slice(0, 200) : null;
}

export function normalizeItemState(it: PlanItem) {
  if (it.state === 'IN_STOCK') {
    it.partnerKey = null; it.issueDate = null; it.invoiceKey = null; it.salePrice = null; it.warrantyStart = null;
  }
  if (it.state !== 'RESERVED') { it.outAt = null; it.outPartnerKey = null; it.outNote = null; }
  if (it.state === 'SOLD' || it.state === 'RENTED') it.warehouseKey = null;
}
