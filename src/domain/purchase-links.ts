/**
 * Veza ulaznog računa s narudžbenicom i primkom — pravilo „trošak robe se knjiži
 * jednom". Primka knjiži trošak „Nabava robe" (nabavna vrijednost uređaja), a
 * ulazni račun iste robe je samo isprava za knjigovođu: njegov vlastiti trošak
 * nastaje samo kad roba nije (još) knjižena primkom.
 *
 *   • „račun za robu s primke" (jedan po narudžbenici/primci) povezan s primkom
 *     koja ima trošak → račun NE knjiži svoj trošak (postojeći se briše)
 *   • drugi računi iste narudžbenice (prijevoz, dodatni troškovi, drugi račun)
 *     knjiže se zasebno — zadano je račun za robu samo onaj čiji iznos odgovara
 *     vrijednosti primki ili narudžbenice (±1 % ili 1 €) i nijedan drugi povezani
 *     račun već nije račun za tu robu; korisnik to može izričito promijeniti
 *   • primka po narudžbenici čiji ulazni račun već ima vlastiti trošak → primka
 *     NE knjiži trošak (račun je stigao i knjižen prije robe)
 *   • zaprimljeni (neprihvaćeni) eRačun i odbijeni račun ne knjiže ništa
 *   • storno primke briše njen trošak; račun tada može „Knjiži ponovno"
 */

export type InvoiceExpenseMode = 'own' | 'receipt' | 'none';

/**
 * Kako ulazni račun stoji s troškom: `own` = knjiži vlastiti trošak,
 * `receipt` = trošak robe je već knjižen primkom (samo račun za robu), `none` = ne knjiži se.
 */
export function invoiceExpenseMode(a: { book: boolean; rejected: boolean; pending?: boolean; receiptExpenses: number; goods: boolean }): InvoiceExpenseMode {
  if (a.rejected || a.pending) return 'none';
  if (a.goods && a.receiptExpenses > 0) return 'receipt';
  return a.book ? 'own' : 'none';
}

/** Odgovara li osnovica računa vrijednosti robe (primki ili narudžbenice): razlika do 1 % ili 1 €. */
export function matchesGoodsAmount(net: number, refs: number[]): boolean {
  return refs.some((t) => t > 0 && Math.abs(net - t) <= Math.max(1, t * 0.01) + 1e-9);
}

/**
 * Zadana odluka „ovo je račun za robu s primke": iznos odgovara vrijednosti robe i
 * nijedan drugi povezani račun već nije račun za tu robu (prvi povezani račun).
 */
export function defaultGoodsInvoice(a: { net: number; refs: number[]; otherGoodsInvoices: number }): boolean {
  return a.otherGoodsInvoices === 0 && matchesGoodsAmount(a.net, a.refs);
}

/** Knjiži li primka trošak nabave. */
export function receiptBooksExpense(a: { bookExpense: boolean; total: number; invoiceOwnExpenses: number }): boolean {
  return a.bookExpense && a.total > 0 && a.invoiceOwnExpenses === 0;
}

/** Stopa PDV-a iz iznosa (za stupac „PDV %" kad stopa nije upisana). */
export function vatPctOf(net: number, vat: number): number | null {
  if (!net) return null;
  return Math.round((vat / net) * 10000) / 100;
}
