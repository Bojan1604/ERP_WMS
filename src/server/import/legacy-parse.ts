/**
 * Čitanje JSON-a stare verzije (Vite/React/Supabase): prepoznavanje oblika
 * datoteke, tolerantne zod sheme (nepoznata polja se zanemaruju, nizovi i
 * brojevi se pretvaraju) i čitanje brojeva i datuma kako ih ljudi upisuju.
 */
import { z } from 'zod';
import type { SourceFormat } from './plan';

// ---------------------------------------------------------------- brojevi i datumi

/**
 * Broj iz stare baze: broj, „1.234,56", „1234.56", „12,5", „1 500 €".
 * Prazno → null; nečitljivo → NaN (pozivatelj upozorava).
 */
export function parseLegacyNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === 'boolean') return Number.NaN;
  if (typeof v !== 'string') return Number.NaN;
  let s = v.replace(/[\s ]/g, '').replace(/€|eur|kn|hrk|%/gi, '');
  if (!s) return null;
  if (!/^[-+]?[\d.,]+$/.test(s) || !/\d/.test(s)) return Number.NaN;
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    // zadnji znak je decimalni, drugi je razdjelnik tisućica
    s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (comma >= 0) {
    s = (s.match(/,/g) ?? []).length > 1 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

const pad = (n: number) => String(n).padStart(2, '0');
const validYmd = (y: number, m: number, d: number) => {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Oznaka nečitljivog datuma. */
export const INVALID = 'INVALID' as const;

/**
 * Datum iz stare baze → `YYYY-MM-DD`. Prihvaća ISO (i s vremenom),
 * „5.3.2026.", „05.03.2026" i milisekunde. Prazno → null, nečitljivo → INVALID.
 */
export function parseLegacyDate(v: unknown): string | null | typeof INVALID {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return INVALID;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? INVALID : d.toISOString().slice(0, 10);
  }
  if (typeof v !== 'string') return INVALID;
  const s = v.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validYmd(y, mo, d)) return INVALID;
    // vrijeme u UTC-u (npr. 2026-03-31T22:30:00Z) je već sljedeći dan u Zagrebu
    if (/T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      const t = new Date(s);
      if (!Number.isNaN(t.getTime())) {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
      }
    }
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\.?$/.exec(s);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : INVALID;
  }
  return INVALID;
}

/** Trenutak (createdAt, ts) → ISO niz ili null. */
export function parseLegacyTimestamp(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : typeof v === 'string' ? new Date(v.trim()) : null;
  if (!d || Number.isNaN(d.getTime())) {
    const day = parseLegacyDate(v);
    return day && day !== INVALID ? `${day}T00:00:00.000Z` : null;
  }
  return d.toISOString();
}

// ---------------------------------------------------------------- zod

/** Tekst: brojevi se pretvaraju u tekst, sve ostalo u prazno. */
const zStr = z.preprocess((v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''), z.string());
/** Id ili prazno (stara baza koristi '' kao „nema veze"). */
const zRef = z.preprocess((v) => (typeof v === 'string' ? v.trim() || null : typeof v === 'number' ? String(v) : null), z.string().nullable());
/** Broj ili null; NaN označava nečitljivu vrijednost. */
const zNum = z.preprocess(parseLegacyNumber, z.union([z.number(), z.nan(), z.null()]));
/** Datum ostaje sirov — čita ga mapper uz upozorenje. */
const zRaw = z.unknown();
const zBool = z.preprocess((v) => (v === true || v === 'true' || v === 1 || v === '1' || v === 'da' ? true : v === false || v === 'false' || v === 0 || v === '0' || v === 'ne' ? false : undefined), z.boolean().optional());
const zIdList = z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : []), z.array(z.string()));
const zObj = z.preprocess((v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}), z.record(z.unknown()));
const zArr = z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown()));

export const legacyUser = z.object({ id: zRef, name: zStr, email: zStr, role: zStr, active: zBool });
export const legacyWarehouse = z.object({ id: zRef, code: zStr, name: zStr, address: zStr, active: zBool, sort: zNum });
export const legacyCategory = z.object({ id: zRef, name: zStr, sort: zNum });
export const legacyModel = z.object({
  id: zRef, brand: zStr, name: zStr, categoryId: zRef, cpu: zStr, screen: zStr, os: zStr, specs: zStr, cost: zNum, price: zNum,
  salePrice: zNum, rentPrice: zNum, rentMonthly: zNum, warrantyMonths: zNum, marginPct: zNum, minStock: zNum, kpd: zStr, code: zStr, active: zBool,
});
export const legacyStatus = z.object({
  id: zRef, name: zStr, color: zStr, inStock: zBool, sold: zBool, rented: zBool, rma: zBool, returning: zBool, reserved: zBool,
  writtenOff: zBool, system: zBool, sort: zNum,
});
export const legacyService = z.object({ id: zRef, name: zStr, price: zNum, unit: zStr, kpd: zStr, note: zStr, active: zBool });
export const legacyPartner = z.object({
  id: zRef, name: zStr, oib: zStr, address: zStr, zip: zStr, city: zStr, countryCode: zStr, country: zStr, vatId: zStr, email: zStr,
  phone: zStr, iban: zStr, contact: zStr, contactPerson: zStr, isCustomer: zBool, isSupplier: zBool, excluded: zBool, note: zStr,
  paymentTermDays: zNum, paymentDays: zNum,
});
export const legacyPackage = z.object({ id: zRef, name: zStr, price: zNum, note: zStr, itemIds: zIdList, createdAt: zRaw });
export const legacyPriceList = z.object({ id: zRef, partnerId: zRef, modelId: zRef, salePrice: zNum, price: zNum, rentPrice: zNum, rentMonthly: zNum, rent: zNum });
export const legacyItem = z.object({
  id: zRef, serial: zStr, dupNote: zStr, statusId: zRef, warehouseId: zRef, partnerId: zRef, modelId: zRef, categoryId: zRef, cpu: zStr, screen: zStr, os: zStr,
  importDate: zRaw, issueDate: zRaw, invoiceId: zRef, contractId: zRef, supplierId: zRef, cost: zNum, salePrice: zNum, rentPrice: zNum,
  marginPct: zNum, warrantyMonths: zNum, warrantyStart: zRaw, note: zStr, outAt: zRaw, outNote: zStr, outPartnerId: zRef,
  writeOffDate: zRaw, writeOffReason: zStr, writeOffNote: zStr, createdAt: zRaw,
});
const legacyLine = z.object({
  itemId: zRef, serial: zStr, desc: zStr, description: zStr, qty: zNum, monthly: zNum, price: zNum, discount: zNum, kind: zStr,
  serviceId: zRef, modelId: zRef, kpd: zStr, unit: zStr, warrantyMonths: zNum, agreed: zBool,
});
export type LegacyLine = z.infer<typeof legacyLine>;
const legacyPayment = z.object({ date: zRaw, amount: zNum, method: zStr, note: zStr, by: zStr });
const legacyCharge = z.object({ kind: zStr, label: zStr, amount: zNum, pct: zNum });
export const legacyInvoice = z.object({
  id: zRef, number: zStr, year: zNum, partnerId: zRef, type: zStr, kind: zStr, period: zStr, description: zStr, date: zRaw, dueDate: zRaw,
  deliveryDate: zRaw, paidDate: zRaw, vatRate: zNum, lines: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(legacyLine.catch(() => null as never))),
  payments: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(legacyPayment.catch(() => null as never))),
  note: zStr, contractId: zRef, refInvoiceId: zRef, stornoId: zRef, taxCategory: zStr, taxReason: zStr,
  charges: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(legacyCharge.catch(() => null as never))),
  advanceAmount: zNum, discountPct: zNum, discountAmount: zNum, eracun: zObj, createdBy: zStr, createdAt: zRaw, rental: zRaw, paymentMethod: zStr,
});
export type LegacyInvoice = z.infer<typeof legacyInvoice>;
export const legacyContract = z.object({
  id: zRef, number: zStr, partnerId: zRef, itemIds: zIdList, prices: zObj, terms: zObj, startDate: zRaw, endDate: zRaw, billing: zStr,
  billingMode: zStr, firstBillingDate: zRaw, billingDay: zNum, seasonal: zRaw, season: zRaw, status: zStr, skipped: zIdList, note: zStr,
  terminatedAt: zRaw, createdBy: zStr, createdAt: zRaw,
});
export type LegacyContract = z.infer<typeof legacyContract>;
export const legacyQuote = z.object({
  id: zRef, number: zStr, partnerId: zRef, date: zRaw, validUntil: zRaw, status: zStr, vatRate: zNum, description: zStr,
  lines: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(legacyLine.catch(() => null as never))),
  discountPct: zNum, discountAmount: zNum, note: zStr, invoiceId: zRef, createdBy: zStr, createdAt: zRaw, hideSerials: zBool,
});
export const legacyOrder = z.object({
  id: zRef, number: zStr, supplierId: zRef, date: zRaw, expectedDate: zRaw, status: zStr, note: zStr, createdBy: zStr, createdAt: zRaw,
  lines: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.object({ modelId: zRef, qty: zNum, cost: zNum, received: zNum }).catch(() => null as never))),
});
export const legacyReceipt = z.object({
  id: zRef, number: zStr, date: zRaw, orderId: zRef, supplierId: zRef, warehouseId: zRef, itemIds: zIdList, expenseId: zRef, status: zStr,
  lines: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.object({ modelId: zRef, qty: zNum, cost: zNum }).catch(() => null as never))),
  note: zStr, createdBy: zStr, createdAt: zRaw, supplierDocNumber: zStr,
});
export const legacyTransfer = z.object({
  id: zRef, number: zStr, date: zRaw, fromWarehouseId: zRef, toWarehouseId: zRef, fromId: zRef, toId: zRef, from: zRef, to: zRef,
  itemIds: zIdList, note: zStr, createdBy: zStr, by: zStr, createdAt: zRaw,
});
export const legacyRma = z.object({
  id: zRef, number: zStr, itemId: zRef, serial: zStr, partnerId: zRef, invoiceId: zRef, reportedDate: zRaw, receivedDate: zRaw, closedDate: zRaw,
  status: zStr, issue: zStr, diagnosis: zStr, action: zStr, solution: zStr, replacementItemId: zRef, cost: zNum, underWarranty: zBool,
  note: zStr, publicNote: zStr, timeline: zArr, createdAt: zRaw,
});
export const legacyInbound = z.object({
  id: zRef, number: zStr, partnerId: zRef, supplierId: zRef, supplierName: zStr, supplierOib: zStr, issueDate: zRaw, dueDate: zRaw,
  receivedDate: zRaw, net: zNum, vat: zNum, total: zNum, vatRate: zNum, status: zStr, paidDate: zRaw, expenseId: zRef, category: zStr,
  note: zStr, rejectReason: zStr, createdAt: zRaw,
});
export const legacyExpense = z.object({
  id: zRef, date: zRaw, category: zStr, description: zStr, partnerId: zRef, amount: zNum, vatRate: zNum, paid: zBool, source: zStr,
  recurring: zRaw, overrides: zObj, note: zStr, createdBy: zStr, createdAt: zRaw, receiptId: zRef,
});
export const legacyAudit = z.object({ ts: zRaw, userName: zStr, entity: zStr, entityId: zRef, action: zStr, summary: zStr });

export type LegacyDb = Record<string, unknown> & { settings?: Record<string, unknown>; rent?: Record<string, unknown> };

// ---------------------------------------------------------------- prepoznavanje oblika

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const looksLikeDb = (v: unknown): v is LegacyDb =>
  isObj(v) && ['items', 'invoices', 'partners', 'models', 'contracts'].some((k) => Array.isArray(v[k]));

export interface Detected {
  format: SourceFormat;
  label: string;
  db: LegacyDb;
  companyName: string | null;
  exportedAt: string | null;
  version: number | null;
  notes: string[];
}

/**
 * Oblici koje stara verzija ostavlja:
 *  • baza firme `{ items, invoices, … }` (Postavke → „Preuzmi kopiju (JSON)")
 *  • omotač `{ data: {…} }` ili `{ db: {…} }`
 *  • dnevna kopija `{ date, savedAt, data }` (ključ `backup:<firma>:<datum>`)
 *  • zapisi po kolekciji `{ "db:<firma>:items": […], … }` (i redci `[{ key, value }]` iz app_kv)
 * Vraća null ako oblik nije prepoznat.
 */
export function detectLegacy(raw: unknown): Detected | null {
  const notes: string[] = [];
  // redci tablice ključ/vrijednost (izvoz app_kv) → objekt
  if (Array.isArray(raw) && raw.every((r) => isObj(r) && typeof r.key === 'string' && 'value' in r)) {
    raw = Object.fromEntries((raw as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value]));
    notes.push('Datoteka je popis zapisa ključ/vrijednost (app_kv) — spojeni u jednu bazu.');
  }
  if (!isObj(raw)) return null;
  const nameOf = (d: LegacyDb) => (isObj(d.settings) && typeof d.settings.companyName === 'string' ? d.settings.companyName.trim() || null : null);
  const version = (d: LegacyDb) => (typeof d.schemaVersion === 'number' ? d.schemaVersion : typeof d.version === 'number' ? d.version : null);

  if (looksLikeDb(raw)) {
    return { format: 'legacy-db', label: 'Baza firme iz stare verzije (izvoz „Preuzmi kopiju")', db: raw, companyName: nameOf(raw), exportedAt: null, version: version(raw), notes };
  }
  if (looksLikeDb(raw.data)) {
    const backup = typeof raw.savedAt === 'string' || typeof raw.date === 'string';
    return {
      format: backup ? 'legacy-backup' : 'legacy-wrapped',
      label: backup ? `Automatska dnevna kopija stare verzije${typeof raw.date === 'string' ? ` (${raw.date})` : ''}` : 'Baza firme u omotaču { data }',
      db: raw.data, companyName: nameOf(raw.data),
      exportedAt: typeof raw.savedAt === 'string' ? raw.savedAt : typeof raw.date === 'string' ? raw.date : null, version: version(raw.data), notes,
    };
  }
  if (looksLikeDb(raw.db)) {
    return { format: 'legacy-wrapped', label: 'Baza firme u omotaču { db }', db: raw.db, companyName: nameOf(raw.db), exportedAt: null, version: version(raw.db), notes };
  }

  // ključevi spremišta: db:<firma>:<kolekcija>, db:<firma>, backup:<firma>:<datum>, companies
  const keys = Object.keys(raw);
  const firms = new Map<string, LegacyDb>();
  for (const k of keys) {
    const m = /^db:([^:]+):([A-Za-z]+)$/.exec(k);
    if (m) {
      const d = firms.get(m[1]) ?? {};
      d[m[2]] = raw[k];
      firms.set(m[1], d);
    }
  }
  for (const k of keys) {
    const m = /^db:([^:]+)$/.exec(k);
    if (m && looksLikeDb(raw[k]) && !firms.has(m[1])) firms.set(m[1], raw[k] as LegacyDb);
  }
  if (!firms.size) {
    const backups = keys.filter((k) => /^backup:[^:]+:\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    const last = backups.at(-1);
    const v = last ? raw[last] : null;
    if (last && isObj(v) && looksLikeDb(v.data)) {
      if (backups.length > 1) notes.push(`Datoteka ima ${backups.length} dnevnih kopija — uzima se najnovija (${last.split(':').pop()}).`);
      return { format: 'legacy-backup', label: `Automatska dnevna kopija stare verzije (${last.split(':').pop()})`, db: v.data, companyName: nameOf(v.data), exportedAt: typeof v.savedAt === 'string' ? v.savedAt : null, version: version(v.data), notes };
    }
    return null;
  }
  const registry = isObj(raw.companies) && Array.isArray(raw.companies.list) ? (raw.companies.list as Array<Record<string, unknown>>) : [];
  const active = isObj(raw.companies) && typeof raw.companies.active === 'string' ? raw.companies.active : null;
  const count = (d: LegacyDb) => (Array.isArray(d.items) ? d.items.length : 0) + (Array.isArray(d.invoices) ? d.invoices.length : 0);
  const ids = [...firms.keys()].sort((a, b) => (a === active ? -1 : b === active ? 1 : count(firms.get(b)!) - count(firms.get(a)!)));
  const firmId = ids[0];
  if (ids.length > 1) notes.push(`Datoteka sadrži ${ids.length} firme (${ids.join(', ')}) — uvozi se „${firmId}". Ostale uvezite zasebno.`);
  const db = firms.get(firmId)!;
  const regName = registry.find((c) => c.id === firmId)?.name;
  return {
    format: 'legacy-split',
    label: 'Zapisi po kolekciji (db:<firma>:<kolekcija>)',
    db,
    companyName: nameOf(db) ?? (typeof regName === 'string' ? regName : null),
    exportedAt: null,
    version: version(db),
    notes,
  };
}
