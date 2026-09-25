import type { NextRequest } from 'next/server';
import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { marginGroups, readMarginFilters, soldItems } from '@/server/queries/margins';
import { formatDate, today } from '@/domain/dates';
import { csvOrXlsx } from '@/server/xlsx';

/** Izvoz marži (CSV / Excel / PDF): prodani uređaji ili skupine po kupcu, modelu, kategoriji. Traži pravo „costs". */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireAccess('costs', 'view');
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status });
    throw e;
  }
  const f = readMarginFilters(Object.fromEntries(req.nextUrl.searchParams.entries()));
  const name = `marze-${f.view}-${f.year}-${today()}`;
  if (f.view === 'kupac' || f.view === 'model' || f.view === 'kategorija') {
    const rows = await marginGroups(user.companyId, f, f.view);
    const label = f.view === 'kupac' ? 'Kupac' : f.view === 'model' ? 'Model' : 'Kategorija';
    return csvOrXlsx(
      req,
      rows,
      [
        { label, value: (r) => r.label },
        { label: 'Uređaja', value: (r) => r.n, type: 'int' },
        { label: 'Nabavna', value: (r) => r.cost, type: 'money' },
        { label: 'Prihod', value: (r) => r.revenue, type: 'money' },
        { label: 'Profit', value: (r) => r.profit, type: 'money' },
        { label: 'Bruto marža %', value: (r) => (r.margin === null ? '' : Math.round(r.margin * 10) / 10), type: 'pct' },
        { label: 'Prosj. prodajna', value: (r) => r.avgPrice, type: 'money' },
      ],
      name,
      'Marže',
    );
  }
  const { rows } = await soldItems(user.companyId, f, { skip: 0, take: 20000 });
  return csvOrXlsx(
    req,
    rows,
    [
      { label: 'Serijski broj', value: (r) => r.serial },
      { label: 'Model', value: (r) => r.model },
      { label: 'Kategorija', value: (r) => r.category },
      { label: 'Kupac', value: (r) => r.partner },
      { label: 'Račun', value: (r) => r.invoice?.number ?? '' },
      { label: 'Datum', value: (r) => (r.date ? formatDate(r.date) : '') },
      { label: 'Nabavna', value: (r) => r.cost, type: 'money' },
      { label: 'Preporučena', value: (r) => r.suggested, type: 'money' },
      { label: 'Prodajna', value: (r) => r.price ?? '', type: 'money' },
      { label: 'Profit', value: (r) => r.profit ?? '', type: 'money' },
      { label: 'Bruto marža %', value: (r) => (r.margin === null ? '' : Math.round(r.margin * 10) / 10), type: 'pct' },
    ],
    name,
    'Marže',
    { landscape: true },
  );
}
