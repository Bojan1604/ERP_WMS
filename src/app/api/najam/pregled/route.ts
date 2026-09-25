import { requireAccess } from '@/server/auth';
import { toError } from '@/server/action';
import { loadOverview, readFilters } from '@/app/(app)/najam/pregled/data';
import { MONTHS_SHORT } from '@/domain/dates';
import type { CsvColumn } from '@/lib/csv';
import { csvOrXlsx } from '@/server/xlsx';

/** Izvoz mreže najma (svi redci filtra, bez straničenja). */
export async function GET(req: Request) {
  try {
    const user = await requireAccess('rentals', 'view');
    const f = readFilters(Object.fromEntries(new URL(req.url).searchParams));
    const { rows } = await loadOverview(user.companyId, f, null);
    type Row = (typeof rows)[number];
    const cols: CsvColumn<Row>[] = [
      { label: 'Klijent', value: (r) => r.partner },
      { label: 'Serijski broj', value: (r) => r.serial },
      { label: 'Model', value: (r) => r.model },
      { label: 'Kategorija', value: (r) => r.category },
      { label: 'Status', value: (r) => r.status.name },
      { label: 'Vrsta', value: (r) => (r.contract ? 'najam' : 'prodaja') },
      { label: 'Ugovor', value: (r) => r.contract?.number },
      { label: 'Mjesečno', value: (r) => r.monthly || null, type: 'money' },
      ...MONTHS_SHORT.map((m, i): CsvColumn<Row> => ({ label: m, value: (r) => r.cells[i].v, type: 'money' })),
      { label: 'Ukupno', value: (r) => r.total, type: 'money' },
    ];
    return await csvOrXlsx(req, rows, cols, `najam-${f.year}`, `Najam ${f.year}`);
  } catch (e) {
    const err = toError(e);
    return new Response(err.ok === false ? err.error : 'Greška', { status: 403 });
  }
}
