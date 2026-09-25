import Link from 'next/link';
import type { Col, Row } from '@/server/queries/reports';
import { Empty, TableWrap } from '@/components/ui/misc';
import { amount, date, integer, pct } from '@/lib/format';
import { cn } from '@/lib/cn';

const NUMERIC = new Set(['money', 'int', 'pct', 'days']);

export function formatCell(c: Col, v: Row[string]) {
  if (v === null || v === undefined || v === '') return null;
  switch (c.kind) {
    case 'money':
      return amount(Number(v));
    case 'int':
      return integer(Number(v));
    case 'pct':
      return pct(Number(v));
    case 'days':
      return `${integer(Number(v))} d`;
    case 'date':
      return date(String(v));
    default:
      return String(v);
  }
}

/** Tablica izvještaja s retkom ukupno; prvi stupac vodi na detalj kad red ima poveznicu. */
export function ReportTable({ columns, rows, totals }: { columns: Col[]; rows: Row[]; totals?: Row | null }) {
  if (!rows.length) return <TableWrap><Empty title="Nema podataka" description="Za odabrane filtre nema zapisa." /></TableWrap>;
  const firstTotalKey = columns[0]?.key;
  // široke (pivot) tablice na mobitelu ostaju tablice s vodoravnim klizanjem i zaključanim prvim stupcem; ostale postaju kartice
  const wide = columns.length > 7;
  const stick = (ci: number, bg: string) => wide && ci === 0 && cn('max-sm:sticky max-sm:left-0 max-sm:shadow-[1px_0_0_var(--color-line)]', bg);
  return (
    // ispis: bez visine i klizanja (inače se reže na jednu stranicu), sitniji font; široke tablice ispisuju se položeno (stranica izvještaja)
    <TableWrap className="max-h-[70vh] overflow-y-auto max-sm:max-h-none print:max-h-none print:overflow-visible print:rounded-none print:shadow-none">
      <table className={cn('data-table compact print:text-[10px] print:[&_td]:px-1.5 print:[&_td]:py-0.5 print:[&_th]:px-1.5', wide && 'no-stack [&_td]:whitespace-nowrap print:[&_td]:whitespace-normal', columns.length > 10 && 'print:text-[8.5px]')}>
        <thead>
          <tr>
            {columns.map((c, ci) => (
              <th key={c.key} className={cn(NUMERIC.has(c.kind ?? '') && 'num', stick(ci, 'max-sm:z-[2] max-sm:bg-panel-2'))}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn(r._muted === 'bad' && '[&>td]:text-bad-strong')}>
              {columns.map((c, ci) => {
                const f = formatCell(c, r[c.key]);
                const negative = (c.kind === 'money' || c.kind === 'days') && Number(r[c.key]) < 0;
                return (
                  <td key={c.key} className={cn(NUMERIC.has(c.kind ?? '') && 'num', c.kind === 'mono' && 'font-mono text-sm', negative && 'text-bad-strong', ci === 0 && 'font-medium', stick(ci, 'max-sm:z-[1] max-sm:bg-panel'))}>
                    {f === null ? (
                      <span className="text-fg-4">—</span>
                    ) : ci === 0 && r._href ? (
                      <Link prefetch={false} href={r._href} className="link">
                        {f}
                      </Link>
                    ) : (
                      f
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot className="sticky bottom-0 max-sm:static print:static">
            <tr>
              {columns.map((c, ci) => {
                const v = totals[c.key];
                return (
                  <td key={c.key} className={cn(NUMERIC.has(c.kind ?? '') && 'num', Number(v) < 0 && c.kind === 'money' && 'text-bad-strong', stick(ci, 'max-sm:z-[1]'))}>
                    {c.key === firstTotalKey && (v === undefined || v === null) ? 'Ukupno' : (formatCell(c, v ?? null) ?? '')}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </TableWrap>
  );
}
