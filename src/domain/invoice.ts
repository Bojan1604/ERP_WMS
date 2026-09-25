import { daysBetween, today, type ISODate } from './dates';
import { r2, sum } from './money';

/**
 * Obračun dokumenta (račun, ponuda). Ulaz su obični brojevi — servisni sloj
 * pretvara Decimal iz baze prije poziva, pa je ovo testabilno bez baze.
 *
 *   lineNet   = qty × cijena × (1 − popust stavke)
 *   linesNet  = Σ lineNet
 *   discount  = min(|linesNet|, |linesNet| × popust% + fiksni popust), predznak dokumenta
 *   net       = linesNet − discount
 *   vat       = net × stopa
 *   total     = net + vat + neoporezive naknade
 */
export interface LineInput {
  qty: number;
  unitPrice: number;
  discountPct?: number;
}

export interface ChargeInput {
  kind: 'N' | 'POVNAK' | 'PP' | 'PPMV';
  label?: string;
  amount?: number;
  /** Samo PP: postotak od osnovice. */
  pct?: number;
}

export interface DocumentInput {
  lines: LineInput[];
  vatRate: number;
  discountPct?: number;
  discountAmount?: number;
  charges?: ChargeInput[];
}

export const CHARGE_KINDS: Record<ChargeInput['kind'], { label: string; pct?: boolean }> = {
  N: { label: 'Neoporeziva naknada' },
  POVNAK: { label: 'Povratna naknada' },
  PP: { label: 'Porez na potrošnju', pct: true },
  PPMV: { label: 'Posebni porez na motorna vozila' },
};

export function lineNet(l: LineInput): number {
  return r2(l.qty * l.unitPrice * (1 - (l.discountPct ?? 0) / 100));
}

export interface DocumentTotals {
  linesNet: number;
  discount: number;
  net: number;
  vat: number;
  charges: number;
  total: number;
  lineNets: number[];
}

export function documentTotals(doc: DocumentInput): DocumentTotals {
  const lineNets = doc.lines.map(lineNet);
  const linesNet = r2(lineNets.reduce((a, b) => a + b, 0));
  const sign = linesNet < 0 ? -1 : 1;
  const abs = Math.abs(linesNet);
  const discount = sign * r2(Math.min(abs, (abs * (doc.discountPct ?? 0)) / 100 + Math.abs(doc.discountAmount ?? 0)));
  const net = r2(linesNet - discount);
  const vat = r2(net * (doc.vatRate / 100));
  const charges = sum(doc.charges ?? [], (c) => {
    const def = CHARGE_KINDS[c.kind] ?? CHARGE_KINDS.N;
    const a = def.pct && c.pct ? (Math.abs(net) * c.pct) / 100 : Math.abs(c.amount ?? 0);
    return (net < 0 ? -1 : 1) * r2(a);
  });
  return { linesNet, discount, net, vat, charges, total: r2(net + vat + charges), lineNets };
}

/**
 * Udio stavke u osnovici nakon popusta na cijeli dokument — za maržu po uređaju
 * i zaradu uređaja (popust se raspoređuje razmjerno).
 */
export function lineShareOfNet(totals: DocumentTotals, index: number): number {
  if (!totals.linesNet) return 0;
  const l = totals.lineNets[index] ?? 0;
  return r2(l - totals.discount * (l / totals.linesNet));
}

// ---------------------------------------------------------------- naplata

export type InvoiceKindCode = 'INVOICE' | 'ADVANCE' | 'STORNO' | 'CREDIT_NOTE';

/** Račun i predujam imaju potraživanje; storno i odobrenje nemaju. */
export const isReceivable = (kind: InvoiceKindCode) => kind === 'INVOICE' || kind === 'ADVANCE';

export function openAmount(args: {
  kind: InvoiceKindCode;
  stornoed: boolean;
  total: number;
  advance: number;
  paid: number;
}): number {
  if (args.stornoed || !isReceivable(args.kind)) return 0;
  return Math.max(0, r2(args.total - args.advance - args.paid));
}

/**
 * Preplata — iznos za povrat kupcu: uplate, uračunati predujam i odobrenja zajedno
 * premašuju iznos računa (npr. odobrenje izdano na već plaćen račun).
 */
export function overpaidAmount(args: { kind: InvoiceKindCode; stornoed: boolean; total: number; advance: number; paid: number; credited: number }): number {
  if (args.stornoed || !isReceivable(args.kind)) return 0;
  return Math.max(0, r2(args.paid + args.advance + args.credited - args.total));
}

export type PaymentStateKey = 'draft' | 'paid' | 'partial' | 'overdue' | 'open' | 'stornoed' | 'storno' | 'credit';

export interface PaymentState {
  key: PaymentStateKey;
  label: string;
  tone: 'neutral' | 'positive' | 'warning' | 'negative' | 'info' | 'accent';
  /** Dani od izdavanja; staje na datumu zadnje uplate. */
  days: number;
}

export function paymentState(
  inv: {
    status: 'DRAFT' | 'ISSUED';
    kind: InvoiceKindCode;
    stornoed: boolean;
    date: ISODate;
    dueDate?: ISODate | null;
    total: number;
    paid: number;
    open: number;
    lastPaymentDate?: ISODate | null;
  },
  overdueDays: number,
  now: ISODate = today(),
): PaymentState {
  if (inv.status === 'DRAFT') return { key: 'draft', label: 'Nacrt', tone: 'neutral', days: 0 };
  if (inv.stornoed) return { key: 'stornoed', label: 'Stornirano', tone: 'neutral', days: 0 };
  if (inv.kind === 'STORNO') return { key: 'storno', label: 'Storno', tone: 'negative', days: 0 };
  if (inv.kind === 'CREDIT_NOTE') return { key: 'credit', label: 'Odobrenje', tone: 'info', days: 0 };
  if (inv.open <= 0.005 && inv.total > 0) {
    return { key: 'paid', label: 'Plaćeno', tone: 'positive', days: daysBetween(inv.date, inv.lastPaymentDate || inv.date) };
  }
  const days = daysBetween(inv.date, now);
  // kasni: prošao rok plaćanja, a ako roka nema — prag iz postavki
  const late = inv.dueDate ? now > inv.dueDate && days > 0 : days > overdueDays;
  if (inv.paid > 0) {
    const pct = inv.total ? Math.round((inv.paid / inv.total) * 100) : 0;
    return { key: late ? 'overdue' : 'partial', label: `Djelomično (${pct} %)`, tone: late ? 'negative' : 'accent', days };
  }
  if (late) return { key: 'overdue', label: 'Kasni', tone: 'negative', days };
  return { key: 'open', label: 'Nije dospjelo', tone: 'warning', days };
}

// ---------------------------------------------------------------- numeracija

/**
 * Broj računa po pravilima Porezne uprave: redni broj / oznaka poslovnog
 * prostora / oznaka naplatnog uređaja, npr. 12/PP1/1. Redni broj kreće od 1
 * svake godine, bez vodećih nula.
 */
export function formatInvoiceNumber(seq: number, premises: string, device: string, sep = '/'): string {
  return `${seq}${sep}${premises}${sep}${device}`;
}

/** Ostali dokumenti: PON-2026-0012, UG-2026-0003… */
export function formatDocNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

/** Poziv na broj HR00: redni broj-godina (bez slova iz oznake prostora). */
export function paymentReference(seq: number, year: number): string {
  return `${seq}-${year}`;
}

export const INVOICE_KIND_LABEL: Record<InvoiceKindCode, string> = {
  INVOICE: 'Račun',
  ADVANCE: 'Račun za predujam',
  STORNO: 'Storno računa',
  CREDIT_NOTE: 'Knjižno odobrenje',
};

// ---------------------------------------------------------------- grupiranje stavki

/**
 * Uređaji istog modela, cijene, popusta, jedinice, KPD-a i jamstva prikazuju se kao
 * jedna stavka s količinom i popisom serijskih brojeva (u bazi ostaje redak po
 * uređaju — skladište, jamstvo i marža vode se po komadu). Grupiraju se samo ako
 * zbroj redaka daje isti iznos kao jedna stavka (bez razlike u zaokruživanju).
 */
export function groupLines<T extends { qty: number; unitPrice: number; discountPct: number }>(
  lines: T[],
  keyOf: (l: T) => string | null,
): { key: string; lines: T[] }[] {
  const out: { key: string; lines: T[] }[] = [];
  const open = new Map<string, { key: string; lines: T[] }>();
  lines.forEach((l, i) => {
    const k = keyOf(l);
    const g = k === null ? undefined : open.get(k);
    if (g) {
      const merged = lineNet({ qty: g.lines.reduce((a, x) => a + x.qty, 0) + l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct });
      const summed = r2([...g.lines, l].reduce((a, x) => a + lineNet(x), 0));
      if (merged === summed) {
        g.lines.push(l);
        return;
      }
    }
    const ng = { key: k ?? `#${i}`, lines: [l] };
    out.push(ng);
    if (k !== null) open.set(k, ng);
  });
  return out;
}

/** Ključ grupiranja uređaja (null = stavka se ne grupira). */
export function deviceLineKey(l: {
  kind: string;
  itemId?: string | null;
  modelId?: string | null;
  description: string;
  unit: string;
  kpd?: string | null;
  unitPrice: number;
  discountPct: number;
  warrantyMonths?: number | null;
}): string | null {
  if (l.kind !== 'DEVICE' || !l.itemId) return null;
  return [l.modelId ?? '', l.description.trim(), l.unit, l.kpd ?? '', l.unitPrice, l.discountPct, l.warrantyMonths ?? ''].join('|');
}

/**
 * Isti model na računu ide po istoj cijeni — inače bi se (cijena iz marže je po
 * komadu) dva ista uređaja prikazala kao dvije stavke. Novi uređaj preuzima cijenu,
 * popust, jamstvo i KPD stavke istog modela koja je već na računu; komadi istog
 * modela dodani zajedno dobivaju prosječnu cijenu (ukupni iznos ostaje isti).
 */
export function unifyDevicePrices<
  T extends { kind: string; modelId?: string | null; description: string; unitPrice: number; discountPct: number; warrantyMonths?: number | null; kpd?: string | null; agreedPrice?: boolean },
>(existing: readonly T[], added: T[]): T[] {
  const modelKey = (l: T) => (l.kind === 'DEVICE' && l.modelId ? `${l.modelId}|${l.description.trim()}` : null);
  const onInvoice = new Map<string, T>();
  for (const l of existing) {
    const k = modelKey(l);
    if (k && !onInvoice.has(k)) onInvoice.set(k, l);
  }
  const avg = new Map<string, number>();
  const buckets = new Map<string, number[]>();
  for (const l of added) {
    const k = modelKey(l);
    if (k && !onInvoice.has(k)) buckets.set(k, [...(buckets.get(k) ?? []), l.unitPrice]);
  }
  for (const [k, ps] of buckets) avg.set(k, Math.round((ps.reduce((s, p) => s + p, 0) / ps.length) * 100) / 100);
  return added.map((l) => {
    const k = modelKey(l);
    if (!k) return l;
    const ref = onInvoice.get(k);
    if (ref) return { ...l, unitPrice: ref.unitPrice, discountPct: ref.discountPct, warrantyMonths: ref.warrantyMonths, kpd: ref.kpd, agreedPrice: ref.agreedPrice };
    return { ...l, unitPrice: avg.get(k) ?? l.unitPrice };
  });
}
