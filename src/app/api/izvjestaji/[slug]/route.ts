import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { findReport, readFilters, runReport, type Row } from '@/server/queries/reports';
import { csvResponse, toCsv } from '@/lib/csv';
import { formatDate, today } from '@/domain/dates';

/** Izvoz izvještaja u CSV (Excel) s istim filtrima kao na ekranu. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  let user;
  try {
    user = await requireAccess('reports', 'view');
  } catch (e) {
    return new Response(e instanceof AuthError ? e.message : 'Greška', { status: e instanceof AuthError ? e.status : 500 });
  }
  const def = findReport((await params).slug);
  if (!def) return new Response('Izvještaj ne postoji.', { status: 404 });
  const f = readFilters(def, Object.fromEntries(new URL(req.url).searchParams));
  const res = await runReport(def, user.companyId, f);
  const rows: Row[] = res.totals ? [...res.rows, { ...res.totals, [res.columns[0].key]: res.totals[res.columns[0].key] ?? 'Ukupno' }] : res.rows;
  const csv = toCsv(
    rows,
    res.columns.map((c) => ({
      label: c.label,
      value: (r: Row) => {
        const v = r[c.key];
        if (v === null || v === undefined) return '';
        if (c.kind === 'date') return formatDate(String(v));
        if (c.kind === 'pct' && typeof v === 'number') return Math.round(v * 100) / 100;
        return v;
      },
    })),
  );
  const suffix = def.filters.includes('year') ? `-${f.year}` : `-${today()}`;
  return csvResponse(csv, `${def.slug}${suffix}.csv`);
}
