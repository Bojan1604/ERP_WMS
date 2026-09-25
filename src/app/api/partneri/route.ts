import { requireAccess } from '@/server/auth';
import { db } from '@/server/db';
import { AuthError } from '@/server/errors';
import { partnerListSelect, partnerStats, partnerWhere } from '@/server/queries/partners';
import { csvOrXlsx } from '@/server/xlsx';
import { today } from '@/domain/dates';

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
    select: { ...partnerListSelect, vatId: true, address: true, zip: true, iban: true, contactPerson: true, paymentTermDays: true },
  });
  // brojke po dijelovima, da upit s IN ostane razumne veličine
  const stats = new Map<string, { open: number; devices: number; contracts: number }>();
  for (let i = 0; i < rows.length; i += 2000) {
    const part = await partnerStats(user.companyId, rows.slice(i, i + 2000).map((r) => r.id));
    for (const [k, v] of part) stats.set(k, v);
  }
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
    { label: 'Otvoreno', value: (r) => stats.get(r.id)?.open ?? 0 },
    { label: 'Uređaja', value: (r) => stats.get(r.id)?.devices ?? 0 },
    { label: 'Aktivnih ugovora', value: (r) => stats.get(r.id)?.contracts ?? 0 },
  ],
    `partneri-${today()}`,
    'Partneri',
  );
}
