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
