import 'server-only';
import { db } from '../db';
import { getCompany } from './lookups';
import { num } from '@/domain/money';
import { packageTotals, suggestedSalePrice } from '@/domain/pricing';
import type { MarginFilters } from './margins';
import { escapeLike } from '@/lib/like';

/**
 * Paketi: skupine uređaja s ukupnom nabavnom, preporučenom cijenom (zbroj
 * preporučenih cijena uređaja), cijenom paketa, profitom i maržom. Uređaji koji
 * više nisu na skladištu označeni su (paket se tada ne može pretvoriti bez izmjene).
 */
export async function packages(companyId: string, f: Pick<MarginFilters, 'q'>) {
  const company = await getCompany(companyId);
  const rows = await db.package.findMany({
    where: {
      companyId,
      ...(f.q ? { OR: [{ name: { contains: escapeLike(f.q), mode: 'insensitive' } }, { note: { contains: escapeLike(f.q), mode: 'insensitive' } }, { items: { some: { item: { serial: { contains: escapeLike(f.q), mode: 'insensitive' } } } } }] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 100,
    select: {
      id: true,
      name: true,
      price: true,
      note: true,
      createdAt: true,
      items: {
        orderBy: { sort: 'asc' },
        select: {
          item: {
            select: {
              id: true,
              serial: true,
              state: true,
              cost: true,
              marginPct: true,
              modelId: true,
              contractItem: { select: { id: true } },
              model: { select: { brand: true, name: true, salePrice: true, marginPct: true, category: { select: { name: true } } } },
            },
          },
        },
      },
    },
  });
  const companyMargin = num(company.defaultMarginPct);
  return rows.map((p) => {
    const items = p.items.map(({ item: i }) => {
      const cost = num(i.cost);
      const price = suggestedSalePrice({
        modelPrice: i.model.salePrice === null ? null : num(i.model.salePrice),
        cost,
        itemMargin: i.marginPct === null ? null : num(i.marginPct),
        modelMargin: i.model.marginPct === null ? null : num(i.model.marginPct),
        companyMargin,
      }).price;
      return {
        id: i.id,
        serial: i.serial,
        modelId: i.modelId,
        model: [i.model.brand, i.model.name].filter(Boolean).join(' '),
        category: i.model.category?.name ?? null,
        cost,
        price,
        available: (i.state === 'IN_STOCK' || i.state === 'RESERVED') && !i.contractItem,
      };
    });
    const t = packageTotals(items, p.price === null ? null : num(p.price));
    return {
      id: p.id,
      name: p.name,
      note: p.note,
      date: p.createdAt,
      ownPrice: p.price === null ? null : num(p.price),
      items,
      devices: items.length,
      unavailable: items.filter((i) => !i.available).map((i) => i.serial),
      models: [...new Set(items.map((i) => i.model))].slice(0, 8),
      ...t,
    };
  });
}
