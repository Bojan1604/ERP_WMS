import 'server-only';
import { cache } from 'react';
import { db } from '../db';

/** Šifrarnici firme — jednom po zahtjevu, za padajuće izbornike i filtre. */
export const getLookups = cache(async (companyId: string) => {
  const [warehouses, categories, models, statuses, services, expenseCategories] = await Promise.all([
    db.warehouse.findMany({ where: { companyId, active: true }, orderBy: [{ sort: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }),
    db.category.findMany({ where: { companyId }, orderBy: [{ sort: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }),
    db.deviceModel.findMany({
      where: { companyId, active: true },
      orderBy: [{ brand: 'asc' }, { name: 'asc' }],
      select: { id: true, brand: true, name: true, categoryId: true, rentPrice: true, salePrice: true, warrantyMonths: true, kpd: true },
    }),
    db.itemStatus.findMany({ where: { companyId }, orderBy: [{ sort: 'asc' }, { name: 'asc' }], select: { id: true, name: true, kind: true, color: true, system: true } }),
    db.service.findMany({ where: { companyId, active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, unit: true, price: true, kpd: true } }),
    db.expenseCategory.findMany({ where: { companyId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);
  return { warehouses, categories, models, statuses, services, expenseCategories };
});

/** Partneri za odabir (samo osnovni podaci). */
export const getPartnerOptions = cache(async (companyId: string, role: 'customer' | 'supplier' | 'any' = 'any') => {
  return db.partner.findMany({
    where: { companyId, ...(role === 'customer' ? { isCustomer: true } : role === 'supplier' ? { isSupplier: true } : {}) },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, city: true, country: true, excluded: true },
  });
});

export const getCompany = cache(async (companyId: string) => db.company.findUniqueOrThrow({ where: { id: companyId } }));

export const modelLabel = (m: { brand?: string | null; name: string }) => [m.brand, m.name].filter(Boolean).join(' ');
