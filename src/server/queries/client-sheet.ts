import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { paramStr } from '@/lib/list-params';
import { deviceWarrantyEnd } from './service';

/** Pogledi popisa uređaja kod klijenta (C3): u najmu (na ugovoru), prodani (bez ugovora), svi. */
export const SHEET_VIEWS = ['najam', 'prodano', 'sve'] as const;
export type SheetView = (typeof SHEET_VIEWS)[number];

/** Redaka po stranici dokumenta na ekranu (ispis je po stranicama); izvoz nema ograničenja. */
export const SHEET_MAX = 500;

type Params = Record<string, string | string[] | undefined>;

export function readSheetParams(params: Params | URLSearchParams) {
  const v = paramStr(params, 'pogled');
  return { view: (SHEET_VIEWS as readonly string[]).includes(v) ? (v as SheetView) : ('najam' as SheetView), contractId: paramStr(params, 'ugovor') || null };
}

/**
 * Popis uređaja klijenta („ClientSheet"): po partneru (uređaji kod njega) ili
 * po ugovoru (uređaji na ugovoru). Mjesečni najam s ugovora, prodajna cijena
 * za kupljene; nabavne cijene se ne čitaju. Uvjeti ugovora za podnožje.
 * Zbrojevi se računaju u bazi (ne iz prikazanih redaka); `limit: null` = svi retci (izvoz),
 * inače stranica od `skip`. Uvjeti ugovora obuhvaćaju sve ugovore pogleda, ne samo stranice.
 * Bez prava na najam (`rentals: false`) podaci ugovora (broj, mjesečni najam, uvjeti) se ne vraćaju.
 */
export async function clientSheet(
  companyId: string,
  partnerId: string,
  opts: { view: SheetView; contractId?: string | null; limit?: number | null; skip?: number; rentals?: boolean },
) {
  const rentals = opts.rentals !== false;
  const limit = opts.limit === undefined ? SHEET_MAX : opts.limit;
  const [partner, contract] = await Promise.all([
    db.partner.findFirst({ where: { id: partnerId, companyId } }),
    opts.contractId ? db.contract.findFirst({ where: { id: opts.contractId, companyId, partnerId }, select: { id: true, number: true } }) : null,
  ]);
  if (!partner || (opts.contractId && !contract)) return null;
  const base: Prisma.ItemWhereInput = contract ? { companyId, contractItem: { is: { contractId: contract.id } } } : { companyId, partnerId, state: { not: 'WRITTEN_OFF' } }; // otpisani nisu „kod klijenta"
  // prodano = kupljeni uređaji (status prodan), ne svaki uređaj kod klijenta bez ugovora (servis, rezervacija…)
  const viewWhere = (v: SheetView): Prisma.ItemWhereInput =>
    contract || v === 'sve' ? base : v === 'najam' ? { ...base, contractItem: { isNot: null } } : { ...base, state: 'SOLD', contractItem: { is: null } };
  // popis ugovora ima samo uređaje u najmu
  const where = viewWhere(contract ? 'najam' : opts.view);
  const [rent, sold, all, monthlySum, salesSum, contractRefs, items] = await Promise.all([
    db.item.count({ where: viewWhere('najam') }),
    contract ? Promise.resolve(0) : db.item.count({ where: viewWhere('prodano') }),
    db.item.count({ where: base }),
    db.contractItem.aggregate({ where: { item: where }, _sum: { monthly: true } }),
    db.item.aggregate({ where: { AND: [where, { contractItem: { is: null } }] }, _sum: { salePrice: true } }),
    db.contractItem.findMany({ where: { item: where }, distinct: ['contractId'], select: { contractId: true } }),
    db.item.findMany({
      where,
      orderBy: [{ model: { name: 'asc' } }, { serial: 'asc' }, { id: 'asc' }],
      ...(limit ? { take: limit, skip: opts.skip ?? 0 } : {}),
      select: {
        id: true, serial: true, issueDate: true, warrantyStart: true, warrantyMonths: true, salePrice: true,
        status: { select: { name: true, color: true } },
        category: { select: { name: true } },
        model: { select: { brand: true, name: true, warrantyMonths: true, category: { select: { name: true } } } },
        contractItem: { select: { monthly: true, contractId: true } },
      },
    }),
  ]);
  const contractIds = rentals ? contractRefs.map((c) => c.contractId) : [];
  const total = contract || opts.view === 'najam' ? rent : opts.view === 'prodano' ? sold : all;
  const [terms, sums] = contractIds.length
    ? await Promise.all([
        db.contract.findMany({
          where: { id: { in: contractIds }, companyId },
          orderBy: { startDate: 'asc' },
          select: { id: true, number: true, status: true, startDate: true, endDate: true, billing: true, billingMode: true, seasonFrom: true, seasonTo: true },
        }),
        db.contractItem.groupBy({ by: ['contractId'], where: { contractId: { in: contractIds } }, _sum: { monthly: true }, _count: { _all: true } }),
      ])
    : [[], []];
  const sumBy = new Map(sums.map((s) => [s.contractId, { monthly: num(s._sum.monthly), devices: s._count._all }]));
  const numberBy = new Map(terms.map((c) => [c.id, c.number]));
  const rows = items.map((i) => ({
    id: i.id,
    serial: i.serial,
    model: [i.model.brand, i.model.name].filter(Boolean).join(' '),
    category: i.category?.name ?? i.model.category?.name ?? null,
    status: i.status,
    since: i.issueDate ? toISO(i.issueDate) : null,
    warrantyEnd: deviceWarrantyEnd(i),
    contractId: rentals ? (i.contractItem?.contractId ?? null) : null,
    contract: rentals && i.contractItem ? (numberBy.get(i.contractItem.contractId) ?? null) : null,
    monthly: rentals && i.contractItem ? num(i.contractItem.monthly) : null,
    // uređaj u najmu: cijena je najam (bez prava na najam ništa), ne prodajna cijena
    price: i.salePrice === null || (!rentals && i.contractItem) ? null : num(i.salePrice),
  }));
  return {
    partner,
    contract,
    counts: { najam: rent, prodano: sold, sve: all },
    /** Broj uređaja u prikazanom pogledu (svih stranica). */
    total,
    rows,
    /** Ima još redaka iza prikazanih (stranica). */
    truncated: !!limit && total > (opts.skip ?? 0) + rows.length,
    monthly: rentals ? r2(num(monthlySum._sum.monthly)) : 0,
    /** Smije li se prikazati najam (ugovor, mjesečno, uvjeti). */
    rentals,
    sales: r2(num(salesSum._sum.salePrice)),
    contracts: terms.map((c) => ({ ...c, startDate: toISO(c.startDate), endDate: c.endDate ? toISO(c.endDate) : null, ...(sumBy.get(c.id) ?? { monthly: 0, devices: 0 }) })),
  };
}

export type ClientSheet = NonNullable<Awaited<ReturnType<typeof clientSheet>>>;
