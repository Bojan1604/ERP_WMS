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
  return (
    <TableWrap className="max-h-[70vh] overflow-y-auto">
      <table className="data-table compact">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cn(NUMERIC.has(c.kind ?? '') && 'num')}>
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
                  <td key={c.key} className={cn(NUMERIC.has(c.kind ?? '') && 'num', c.kind === 'mono' && 'font-mono text-sm', negative && 'text-bad-strong', ci === 0 && 'font-medium')}>
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
          <tfoot className="sticky bottom-0">
            <tr>
              {columns.map((c) => {
                const v = totals[c.key];
                return (
                  <td key={c.key} className={cn(NUMERIC.has(c.kind ?? '') && 'num', Number(v) < 0 && c.kind === 'money' && 'text-bad-strong')}>
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
