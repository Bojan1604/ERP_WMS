import { r2 } from './money';

/** Bruto profitna marža u % prihoda; null kad nema prihoda. */
export function grossMargin(revenue: number, cost: number): number | null {
  if (!revenue) return null;
  return ((revenue - cost) / revenue) * 100;
}

/** Cijena iz bruto marže: nabavna / (1 − marža). 100 € uz 35 % → 153,85 €. */
export function priceFromMargin(cost: number, marginPct: number): number {
  if (marginPct >= 100) return 0;
  return r2(cost / (1 - marginPct / 100));
}

/** Marža: uređaj → model → globalno. */
export function effectiveMargin(item: number | null | undefined, model: number | null | undefined, company: number): number {
  return item ?? model ?? company;
}

/**
 * Preporučena prodajna cijena: dogovorena za kupca → cijena modela →
 * izračun iz marže.
 */
export function suggestedSalePrice(args: {
  agreed?: number | null;
  modelPrice?: number | null;
  cost: number;
  itemMargin?: number | null;
  modelMargin?: number | null;
  companyMargin: number;
}): { price: number; source: 'agreed' | 'model' | 'margin' } {
  if (args.agreed && args.agreed > 0) return { price: r2(args.agreed), source: 'agreed' };
  if (args.modelPrice && args.modelPrice > 0) return { price: r2(args.modelPrice), source: 'model' };
  const m = effectiveMargin(args.itemMargin, args.modelMargin, args.companyMargin);
  return { price: priceFromMargin(args.cost, m), source: 'margin' };
}

/** Preporučeni mjesečni najam: dogovoreni → uređaj → model → % nabavne. */
export function suggestedRent(args: {
  agreed?: number | null;
  itemRent?: number | null;
  modelRent?: number | null;
  cost: number;
  fallbackPct: number;
}): { price: number; source: 'agreed' | 'item' | 'model' | 'cost' } {
  if (args.agreed && args.agreed > 0) return { price: r2(args.agreed), source: 'agreed' };
  if (args.itemRent && args.itemRent > 0) return { price: r2(args.itemRent), source: 'item' };
  if (args.modelRent && args.modelRent > 0) return { price: r2(args.modelRent), source: 'model' };
  return { price: r2((args.cost * args.fallbackPct) / 100), source: 'cost' };
}

/** Kraj jamstva: od početka jamstva (datum računa) + mjeseci. */
export function warrantyEnd(start: string | null | undefined, months: number | null | undefined): string | null {
  if (!start || !months) return null;
  const [y, m, d] = [Number(start.slice(0, 4)), Number(start.slice(5, 7)), Number(start.slice(8, 10))];
  const t = new Date(Date.UTC(y, m - 1 + months, d));
  return t.toISOString().slice(0, 10);
}

/**
 * Paket (Marže → Paketi): nabavna je zbroj nabavnih uređaja, prijedlog cijene zbroj
 * preporučenih cijena, a cijena paketa ručna ili prijedlog; profit i bruto marža iz njih.
 */
export function packageTotals(items: Array<{ cost: number; price: number }>, price: number | null) {
  const cost = r2(items.reduce((a, i) => a + i.cost, 0));
  const suggested = r2(items.reduce((a, i) => a + i.price, 0));
  const total = price ?? suggested;
  return { cost, suggested, price: total, profit: r2(total - cost), margin: grossMargin(total, cost) };
}

/**
 * Cijena paketa raspoređena na uređaje razmjerno preporučenim cijenama (bez preporučenih
 * — jednako); razlika zaokruživanja ide na prvu stavku, pa je zbroj točno cijena paketa.
 * Bez cijene paketa vrijede preporučene cijene.
 */
export function distributePackagePrice(prices: number[], total: number | null, groups?: Array<string | null | undefined>): number[] {
  if (!prices.length) return [];
  if (groups) return distributeByGroup(prices, total, groups);
  if (total === null) return prices.map(r2);
  const sum = prices.reduce((a, p) => a + p, 0);
  const out = prices.map((p) => r2(sum > 0 ? (p / sum) * total : total / prices.length));
  out[0] = r2(out[0] + total - out.reduce((a, p) => a + p, 0));
  return out;
}

/**
 * Raspodjela po skupinama (model): uređaji istog modela dobivaju istu cijenu — osnovica
 * skupine je prosjek preporučenih cijena. Razlika zaokruživanja ide na jednu stavku,
 * po mogućnosti na model koji je u paketu jednom (ostali modeli ostaju ujednačeni).
 */
function distributeByGroup(prices: number[], total: number | null, groups: Array<string | null | undefined>): number[] {
  const keyOf = (i: number) => groups[i] ?? `#${i}`;
  const sums = new Map<string, { sum: number; n: number }>();
  prices.forEach((p, i) => {
    const g = sums.get(keyOf(i)) ?? { sum: 0, n: 0 };
    g.sum += p;
    g.n += 1;
    sums.set(keyOf(i), g);
  });
  const avg = prices.map((_, i) => {
    const g = sums.get(keyOf(i))!;
    return g.sum / g.n;
  });
  if (total === null) return avg.map(r2);
  const all = avg.reduce((a, p) => a + p, 0);
  const out = avg.map((p) => r2(all > 0 ? (p / all) * total : total / prices.length));
  const rest = r2(total - out.reduce((a, p) => a + p, 0));
  if (rest !== 0) {
    const single = prices.findIndex((_, i) => sums.get(keyOf(i))!.n === 1);
    const at = single >= 0 ? single : 0;
    out[at] = r2(out[at] + rest);
  }
  return out;
}
