import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { findReport, periodLabel, readFilters, runReport, type Row } from '@/server/queries/reports';
import { canSeeCost } from '@/domain/permissions';
import type { ExportColumnType } from '@/lib/csv';
import { csvOrXlsx } from '@/server/xlsx';
import { formatDate, today } from '@/domain/dates';

const COL_TYPE: Record<string, ExportColumnType> = { text: 'text', mono: 'text', money: 'money', int: 'int', days: 'int', pct: 'pct', date: 'date' };

/** Izvoz izvještaja u CSV ili Excel (?format=xlsx) s istim filtrima kao na ekranu. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  let user;
  try {
    user = await requireAccess('reports', 'view');
  } catch (e) {
    return new Response(e instanceof AuthError ? e.message : 'Greška', { status: e instanceof AuthError ? e.status : 500 });
  }
  const def = findReport((await params).slug);
  const costs = canSeeCost(user.perms);
  if (!def || (def.requiresCost && !costs)) return new Response('Izvještaj ne postoji.', { status: 404 });
  const f = readFilters(def, new URL(req.url).searchParams);
  const res = await runReport(def, user.companyId, f, { canSeeCost: costs });
  const rows: Row[] = res.totals ? [...res.rows, { ...res.totals, [res.columns[0].key]: res.totals[res.columns[0].key] ?? 'Ukupno' }] : res.rows;
  const suffix = def.filters.includes('year') ? `-${f.year ?? 'sve'}` : `-${today()}`;
  return csvOrXlsx(
    req,
    rows,
    res.columns.map((c) => ({
      label: c.label,
      type: COL_TYPE[c.kind ?? 'text'],
      value: (r: Row) => {
        const v = r[c.key];
        if (v === null || v === undefined) return '';
        if (c.kind === 'date') return formatDate(String(v));
        if (c.kind === 'pct' && typeof v === 'number') return Math.round(v * 100) / 100;
        return v;
      },
    })),
    `${def.slug}${suffix}`,
    def.title,
    { subtitle: [def.filters.includes('year') || f.from || f.to ? periodLabel(f) : null, def.description].filter(Boolean).join(' · '), companyName: user.companyName, landscape: res.columns.length > 6 },
  );
}
