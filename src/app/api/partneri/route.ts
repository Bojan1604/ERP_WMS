import { requireAccess } from '@/server/auth';
import { db } from '@/server/db';
import { AuthError } from '@/server/errors';
import { partnerListSelect, partnerStats, partnerWhere } from '@/server/queries/partners';
import { csvOrXlsx } from '@/server/xlsx';
import { today } from '@/domain/dates';
import { can } from '@/domain/permissions';
import type { ExportColumn } from '@/lib/csv';

/** Izvoz popisa partnera (s istim filtrima kao na ekranu). */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('partners', 'view');
  } catch (e) {
    return new Response(e instanceof AuthError ? e.message : 'Greška', { status: e instanceof AuthError ? e.status : 500 });
  }
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const rows = await db.partner.findMany({
    where: partnerWhere(user.companyId, params),
    orderBy: { name: 'asc' },
    take: 20_000,
    select: {
      ...partnerListSelect, vatId: true, address: true, zip: true, iban: true, contactPerson: true, paymentTermDays: true,
      endpointId: true, vatCategoryOverride: true, branchCode: true, branchName: true,
    },
  });
  // brojke po dijelovima, da upit s IN ostane razumne veličine
  const stats = new Map<string, { open: number; devices: number; contracts: number; invoices: number; turnover: number }>();
  for (let i = 0; i < rows.length; i += 2000) {
    const part = await partnerStats(user.companyId, rows.slice(i, i + 2000).map((r) => r.id));
    for (const [k, v] of part) stats.set(k, v);
  }
  type Row = (typeof rows)[number];
  // računi, promet i otvoreno samo uz pravo prodaje (kao na ekranu)
  const sales: ExportColumn<Row>[] = can(user.perms, 'sales')
    ? [
        { label: 'Računa', value: (r) => stats.get(r.id)?.invoices ?? 0, type: 'int' },
        { label: 'Promet', value: (r) => stats.get(r.id)?.turnover ?? 0, type: 'money' },
        { label: 'Otvoreno', value: (r) => stats.get(r.id)?.open ?? 0, type: 'money' },
      ]
    : [];
  return csvOrXlsx(
    req,
    rows,
    [
    { label: 'Naziv', value: (r) => r.name },
    { label: 'OIB', value: (r) => r.oib },
    { label: 'PDV ID', value: (r) => r.vatId },
    { label: 'Adresa', value: (r) => r.address },
    { label: 'Poštanski broj', value: (r) => r.zip },
    { label: 'Mjesto', value: (r) => r.city },
    { label: 'Država', value: (r) => r.country },
    { label: 'E-adresa', value: (r) => r.email },
    { label: 'Telefon', value: (r) => r.phone },
    { label: 'IBAN', value: (r) => r.iban },
    { label: 'Kontakt osoba', value: (r) => r.contactPerson },
    { label: 'Kupac', value: (r) => (r.isCustomer ? 'da' : 'ne') },
    { label: 'Dobavljač', value: (r) => (r.isSupplier ? 'da' : 'ne') },
    { label: 'Isključen', value: (r) => (r.excluded ? 'da' : 'ne') },
    { label: 'Rok plaćanja', value: (r) => r.paymentTermDays },
    { label: 'eRačun adresa', value: (r) => r.endpointId },
    { label: 'PDV kategorija (ručno)', value: (r) => r.vatCategoryOverride },
    { label: 'Poslovna jedinica', value: (r) => [r.branchCode, r.branchName].filter(Boolean).join(' ') },
    ...sales,
    { label: 'Uređaja', value: (r) => stats.get(r.id)?.devices ?? 0 },
    ...(can(user.perms, 'rentals') ? [{ label: 'Aktivnih ugovora', value: (r: Row) => stats.get(r.id)?.contracts ?? 0 }] : []),
  ],
    `partneri-${today()}`,
    'Partneri',
  );
}
