import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { getStocktake, stocktakeReport, type SnapRow } from '@/server/queries/stocktake';
import { csvResponse, toCsv } from '@/lib/csv';
import { STOCKTAKE_KIND_LABEL } from '@/domain/warehouse';
import { dateTime } from '@/lib/format';

/** CSV inventure: svi pronađeni, nedostajući i višak s razlogom. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAccess('warehouse', 'view');
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500;
    return new Response(e instanceof Error ? e.message : 'Greška', { status });
  }
  const { id } = await params;
  const st = await getStocktake(user.companyId, id);
  if (!st) return new Response('Inventura ne postoji.', { status: 404 });
  const rep = await stocktakeReport(user.companyId, st);
  type Row = SnapRow & { result: string };
  const rows: Row[] = [
    ...rep.missing.map((r) => ({ ...r, result: 'Nedostaje' })),
    ...rep.extra.map((r) => ({ ...r, result: `Višak — ${r.kind ? STOCKTAKE_KIND_LABEL[r.kind].toLowerCase() : ''}` })),
    ...rep.found.map((r) => ({ ...r, result: 'Pronađen' })),
  ];
  const csv = toCsv<Row>(rows, [
    { label: 'Rezultat', value: (r) => r.result },
    { label: 'Serijski broj', value: (r) => r.serial },
    { label: 'Model', value: (r) => r.model },
    { label: 'Status', value: (r) => r.status },
    { label: 'Skladište', value: (r) => r.warehouse },
    { label: 'Skenirao', value: (r) => r.by },
    { label: 'Skenirano', value: (r) => (r.at ? dateTime(r.at) : '') },
  ]);
  return csvResponse(csv, `inventura-${st.number}.csv`);
}
