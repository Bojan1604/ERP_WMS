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
