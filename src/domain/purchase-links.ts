/**
 * Trošak robe po narudžbenici — JEDNO pravilo (usklađivanje: `reconcileOrderGoodsExpense`
 * u server/services/goods-expense.ts; opis i u docs/RAZVOJ.md → „Trošak robe u nabavi").
 *
 *   Ukupni knjiženi trošak robe skupine = max(R, I), nikad R + I, gdje je
 *     R = zbroj troškova „Nabava robe" proknjiženih primki skupine (primka s kvačicom
 *         „Knjiži nabavu u troškove"; stornirana primka nema trošak),
 *     I = zbroj osnovica računa za robu skupine koji se knjiže (prihvaćeni, „Knjiži kao trošak").
 *
 *   Skupina = narudžbenica (sve njene primke i svi računi povezani s njom); primka bez
 *   narudžbenice je skupina sama za sebe (računi povezani samo s njom); nepovezani račun
 *   je sam svoja skupina (R = 0).
 *
 *   Kako se to postiže: primka UVIJEK knjiži svoju nabavnu vrijednost (ako je korisnik to
 *   odabrao) — usklađivanje nikad ne mijenja trošak primke. Računi za robu, redom po datumu
 *   računa (pa po upisu), „troše" R: dio osnovice koji pokrivaju primke ne knjiže, a knjiže samo
 *   razliku iznad primki (vlastiti trošak = osnovica − pokriveno, PDV razmjerno). Zato je
 *   R + Σ vlastitih = R + max(0, I − R) = max(R, I).
 *
 *   • račun koji NIJE račun za robu (prijevoz, usluga, dodatni trošak) uvijek knjiži cijelu
 *     osnovicu kao zaseban trošak i ne troši R
 *   • zaprimljeni (neprihvaćeni) eRačun, odbijeni račun i račun s isključenim „Knjiži kao
 *     trošak" ne knjiže ništa i ne troše R
 *   • usklađivanje se ponavlja nakon SVAKE promjene skupine (primka, storno primke, knjiženje
 *     troška primke, spremanje/brisanje/povezivanje/prihvat/odbijanje računa, podaci računa na
 *     narudžbenici, „Knjiži ponovno"), pa rezultat ne ovisi o redoslijedu radnji
 *
 * Zadano „račun za robu" (dok korisnik ne odluči kvačicom): račun skupine kategorije
 * „Nabava robe" čija osnovica stane u još nefakturiranu vrijednost robe (djelomični računi),
 * ili — kao prije — prvi povezani račun bez druge kategorije čija osnovica odgovara vrijednosti
 * primki ili narudžbenice (±1 % ili 1 €). Druga kategorija (npr. „Prijevoz") nije roba.
 */

import { r2 } from './money';
import { countLabel } from './plural';

/** Kategorija troška robe (trošak primke i zadana kategorija računa s narudžbenice). */
export const PURCHASE_CATEGORY = 'Nabava robe';

/**
 * Kako ulazni račun stoji s troškom: `own` = knjiži cijelu osnovicu, `partial` = knjiži samo
 * razliku iznad primki, `receipt` = trošak robe u cijelosti nose primke, `none` = ne knjiži se.
 */
export type InvoiceExpenseMode = 'own' | 'partial' | 'receipt' | 'none';

/** Račun skupine kako ga vidi pravilo (redoslijed = redoslijed trošenja R). */
export interface GoodsInvoiceRow {
  id: string;
  net: number;
  vat: number;
  /** Račun za robu (troši trošak primki). */
  goods: boolean;
  /** Knjiži se: prihvaćen (ne zaprimljeni eRačun, ne odbijen) i „Knjiži kao trošak". */
  books: boolean;
}

export interface GoodsAllocation {
  id: string;
  /** Dio osnovice koji pokrivaju troškovi primki. */
  covered: number;
  /** Vlastiti trošak računa (osnovica i PDV); 0 = račun nema troška. */
  ownNet: number;
  ownVat: number;
  mode: InvoiceExpenseMode;
}

/**
 * Pravilo troška robe skupine: `receiptsBooked` = R (zbroj troškova primki), računi redom.
 * Vraća vlastiti trošak svakog računa tako da je R + Σ ownNet (računa za robu) = max(R, I).
 */
export function allocateGoodsExpense(receiptsBooked: number, invoices: GoodsInvoiceRow[]): GoodsAllocation[] {
  let pool = Math.max(0, r2(receiptsBooked));
  return invoices.map((i) => {
    if (!i.books) return { id: i.id, covered: 0, ownNet: 0, ownVat: 0, mode: 'none' as const };
    // odobrenje (negativna osnovica) i račun koji nije za robu ne troše primke
    const covered = i.goods && i.net > 0 ? Math.min(r2(i.net), pool) : 0;
    pool = r2(pool - covered);
    const ownNet = r2(i.net - covered);
    const ownVat = covered === 0 ? r2(i.vat) : r2((i.vat * ownNet) / i.net);
    const mode: InvoiceExpenseMode = ownNet === 0 ? 'receipt' : covered === 0 ? 'own' : 'partial';
    return { id: i.id, covered: r2(covered), ownNet, ownVat, mode };
  });
}

/** Vlastiti troškovi računa za robu (bez računa koji nisu roba). */
function goodsOwn(receiptsBooked: number, invoices: GoodsInvoiceRow[]) {
  return r2(allocateGoodsExpense(receiptsBooked, invoices).reduce((a, x, k) => a + (invoices[k].goods ? x.ownNet : 0), 0));
}

/** Ukupni trošak robe skupine po pravilu: R + vlastiti troškovi računa za robu = max(R, I). */
export function goodsExpenseTotal(receiptsBooked: number, invoices: GoodsInvoiceRow[]): number {
  return r2(receiptsBooked + goodsOwn(receiptsBooked, invoices));
}

/**
 * Što nova primka vrijednosti `value` radi s troškom robe skupine (dijalog zaprimanja) —
 * izvedeno iz istog pravila: primka knjiži `value`, računi za robu se umanjuju za `invoiceReduced`.
 */
export function receiptEffect(receiptsBooked: number, invoices: GoodsInvoiceRow[], value: number) {
  const v = Math.max(0, value);
  const invoiceReduced = r2(goodsOwn(receiptsBooked, invoices) - goodsOwn(receiptsBooked + v, invoices));
  return { invoiceReduced, totalIncrease: r2(v - invoiceReduced) };
}

/**
 * Što bi prihvaćanje računa `id` s „Knjiži kao trošak" knjižilo (dijalog prihvaćanja) — isto pravilo:
 * račun se u skupini računa kao da se knjiži. Račun za robu povezan s primkama knjiži samo razliku.
 */
export function acceptPreview(receiptsBooked: number, invoices: GoodsInvoiceRow[], id: string, goods: boolean) {
  const rows = invoices.map((i) => (i.id === id ? { ...i, goods, books: true } : i));
  const a = allocateGoodsExpense(receiptsBooked, rows).find((x) => x.id === id);
  return a ? { covered: a.covered, ownNet: a.ownNet, mode: a.mode } : null;
}

export interface AcceptBookPreview {
  /** Račun je povezan s narudžbenicom/primkom (vrijedi pravilo max(primke, računi za robu)). */
  linked: boolean;
  /** Račun za robu (troši trošak primki). */
  goods: boolean;
  mode: InvoiceExpenseMode;
  /** Vlastiti trošak koji bi se knjižio; `null` = iznos se ne prikazuje (bez prava `costs`). */
  ownNet: number | null;
}

/**
 * Zadana kvačica „Knjiži kao trošak" i objašnjenje u dijalogu prihvaćanja. Povezani račun se po
 * zadanom knjiži — pravilo troška robe ionako knjiži samo razliku iznad primki (nikad dvaput).
 * Nepovezani račun dobavljača s nedavnim primkama po zadanom se ne knjiži (roba je vjerojatno već
 * knjižena primkom, a bez veze pravilo to ne zna).
 */
export function acceptBookDefault(recentReceipts: number, p: AcceptBookPreview | null, money: (v: number) => string): { book: boolean; hint: string } {
  const amt = (v: number | null) => (v === null ? '' : ` (${money(v)})`);
  if (p?.linked && p.goods) {
    if (p.mode === 'receipt') return { book: true, hint: 'Račun je za robu s primke — trošak robe u cijelosti nose primke, pa se ništa ne knjiži dvaput.' };
    if (p.mode === 'partial') return { book: true, hint: `Knjižit će se samo razlika iznad primke${amt(p.ownNet)}.` };
    return { book: true, hint: `Primke još nemaju knjiženi trošak — knjiži se osnovica računa${amt(p.ownNet)}; kasnija primka je umanjuje (trošak robe nikad dvaput).` };
  }
  if (p?.linked) return { book: true, hint: `Račun nije za robu (npr. prijevoz, usluga) — knjiži se cijela osnovica kao zaseban trošak${amt(p.ownNet)}.` };
  if (recentReceipts > 0) {
    return {
      book: false,
      hint: `Dobavljač ima ${countLabel(recentReceipts, 'primku', 'primke', 'primki')} u 90 dana prije računa, a račun nije povezan s narudžbenicom ni primkom — roba zaprimljena primkom možda je već knjižena kao trošak „Nabava robe". Povežite račun s narudžbenicom/primkom (tada se knjiži samo razlika) ili uključite samo ako račun nije za tu robu (npr. usluga).`,
    };
  }
  return { book: true, hint: 'Za račun robe koja je zaprimljena primkom povežite ga s narudžbenicom ili primkom — tada se knjiži samo razlika iznad primke.' };
}

/** Odgovara li osnovica računa vrijednosti robe (primki ili narudžbenice): razlika do 1 % ili 1 €. */
export function matchesGoodsAmount(net: number, refs: number[]): boolean {
  return refs.some((t) => t > 0 && Math.abs(net - t) <= Math.max(1, t * 0.01) + 1e-9);
}

/**
 * Zadana odluka „račun za robu" (vidi opis gore). `refs` = [vrijednost primki, vrijednost
 * narudžbenice]; `otherGoodsNet` / `otherGoodsInvoices` = zbroj osnovica / broj drugih
 * (neodbijenih) računa za robu iste skupine.
 */
export function defaultGoodsInvoice(a: { net: number; category?: string | null; refs: number[]; otherGoodsNet?: number; otherGoodsInvoices: number }): boolean {
  if (!(a.net > 0)) return false;
  // izričito druga kategorija (prijevoz, usluga…) nije roba
  if (a.category && a.category !== PURCHASE_CATEGORY) return false;
  if (a.otherGoodsInvoices === 0 && matchesGoodsAmount(a.net, a.refs)) return true;
  if (a.category !== PURCHASE_CATEGORY) return false;
  const value = Math.max(0, ...a.refs);
  return value > 0 && a.net <= value - (a.otherGoodsNet ?? 0) + Math.max(1, value * 0.01) + 1e-9;
}

/** Knjiži li primka trošak nabave: uvijek kad je odabrano i ima vrijednost (računi za robu se usklađuju). */
export function receiptBooksExpense(a: { bookExpense: boolean; total: number }): boolean {
  return a.bookExpense && a.total > 0;
}

/** Stopa PDV-a iz iznosa (za stupac „PDV %" kad stopa nije upisana). */
export function vatPctOf(net: number, vat: number): number | null {
  if (!net) return null;
  return Math.round((vat / net) * 10000) / 100;
}
