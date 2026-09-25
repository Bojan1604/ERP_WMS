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

/** Firma bez tajni (certifikat, lozinka, API ključ) — one se čitaju samo u src/server/fiscal. */
export const getCompany = cache(async (companyId: string) =>
  db.company.findUniqueOrThrow({ where: { id: companyId }, omit: { fiscalCert: true, fiscalCertPassword: true, eInvoiceApiKey: true, smtpPassword: true } }),
);

export const modelLabel = (m: { brand?: string | null; name: string }) => [m.brand, m.name].filter(Boolean).join(' ');

/** Boje firme (naglasak, izbornik) za okvir aplikacije i portala — jednom po zahtjevu. */
export const getCompanyColors = cache(async (companyId: string) =>
  db.company.findUnique({ where: { id: companyId }, select: { brandColor: true, menuColor: true } }).then((c) => c ?? { brandColor: null, menuColor: null }),
);
