/**
 * Veza ulaznog računa s narudžbenicom i primkom — pravilo „trošak robe se knjiži
 * jednom". Primka knjiži trošak „Nabava robe" (nabavna vrijednost uređaja), a
 * ulazni račun iste robe je samo isprava za knjigovođu: njegov vlastiti trošak
 * nastaje samo kad roba nije (još) knjižena primkom.
 *
 *   • ulazni račun povezan s primkom (izravno ili preko narudžbenice) koja ima
 *     trošak → račun NE knjiži svoj trošak (postojeći se briše pri povezivanju)
 *   • primka po narudžbenici čiji ulazni račun već ima vlastiti trošak → primka
 *     NE knjiži trošak (račun je stigao i knjižen prije robe)
 *   • storno primke briše njen trošak; račun tada može „Knjiži ponovno"
 */

export type InvoiceExpenseMode = 'own' | 'receipt' | 'none';

/**
 * Kako ulazni račun stoji s troškom: `own` = knjiži vlastiti trošak,
 * `receipt` = trošak robe je već knjižen primkom, `none` = ne knjiži se.
 */
export function invoiceExpenseMode(a: { book: boolean; rejected: boolean; receiptExpenses: number }): InvoiceExpenseMode {
  if (a.rejected) return 'none';
  if (a.receiptExpenses > 0) return 'receipt';
  return a.book ? 'own' : 'none';
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
