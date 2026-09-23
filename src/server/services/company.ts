import 'server-only';
import type { StatusKind } from '@prisma/client';
import type { Tx } from '../db';

/** Sistemski statusi — po jedan za svaku vrstu koju program koristi u logici. */
export const SYSTEM_STATUSES: Array<{ name: string; kind: StatusKind; color: string }> = [
  { name: 'Na skladištu', kind: 'IN_STOCK', color: 'green' },
  { name: 'Izašlo iz skladišta', kind: 'RESERVED', color: 'amber' },
  { name: 'Prodan', kind: 'SOLD', color: 'blue' },
  { name: 'U najmu', kind: 'RENTED', color: 'purple' },
  { name: 'Pokvaren', kind: 'SERVICE', color: 'red' },
  { name: 'U dolasku', kind: 'RETURNING', color: 'teal' },
  { name: 'Otpisan', kind: 'WRITTEN_OFF', color: 'gray' },
];

export const DEFAULT_EXPENSE_CATEGORIES = [
  'Nabava robe', 'Otpis opreme', 'Najam prostora', 'Plaće', 'Telekomunikacije', 'Softver i licence',
  'Gorivo i putni troškovi', 'Knjigovodstvo', 'Marketing', 'Servis i popravci', 'Ostalo',
];

/** Postavljanje nove firme: statusi, zadano skladište, kategorije troškova. */
export async function bootstrapCompany(tx: Tx, companyId: string) {
  await tx.itemStatus.createMany({
    data: [
      ...SYSTEM_STATUSES.map((s, sort) => ({ companyId, ...s, system: true, sort })),
      { companyId, name: 'Demo', kind: 'OTHER' as const, color: 'teal', sort: 20 },
      { companyId, name: 'Servisni uređaj', kind: 'OTHER' as const, color: 'orange', sort: 21 },
    ],
    skipDuplicates: true,
  });
  await tx.warehouse.createMany({ data: [{ companyId, name: 'Glavno skladište' }], skipDuplicates: true });
  await tx.expenseCategory.createMany({ data: DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ companyId, name })), skipDuplicates: true });
}
