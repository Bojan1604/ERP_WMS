import Link from 'next/link';
import { MONTHS_SHORT } from '@/domain/dates';
import { eur, integer } from '@/lib/format';
import { cn } from '@/lib/cn';

const compact1 = new Intl.NumberFormat('hr-HR', { notation: 'compact', maximumFractionDigits: 1 });
const compact0 = new Intl.NumberFormat('hr-HR', { notation: 'compact', maximumFractionDigits: 0 });
/** Kratki iznos za uski stupac („990 tis.", „1,2 mil.") — puni iznos je u opisu (title). */
const short = (v: number) => (Math.abs(v) < 10_000 ? integer(Math.round(v)) : (Math.abs(v) < 100_000 ? compact1 : compact0).format(v));

/** Troškovi po mjesecima: knjiženo i planirano (ponavljajući do kraja godine), stupci bez biblioteke. */
export function MonthSummary({
  booked,
  planned,
  monthHref,
  activeMonth,
}: {
  booked: number[];
  planned: number[];
  monthHref: (m: number | null) => string;
  activeMonth: number | null;
}) {
  const max = Math.max(1, ...booked.map((b, i) => b + planned[i]));
  return (
    <div className="overflow-x-auto scroll-slim">
      <div className="grid min-w-[760px] grid-cols-12 gap-1.5">
        {booked.map((b, i) => {
          const p = planned[i];
          const active = activeMonth === i + 1;
          return (
            <Link prefetch={false}
              key={i}
              href={monthHref(active ? null : i + 1)}
              scroll={false}
              title={`Knjiženo ${eur(b)}${p ? ` · planirano ${eur(p)}` : ''}`}
              className={cn('group flex min-w-0 flex-col items-stretch rounded-md p-1.5 text-center hover:bg-muted', active && 'bg-brand-soft')}
            >
              <div className="flex h-24 flex-col justify-end">
                {p > 0 && <div className="rounded-t-sm border border-dashed border-info/60 bg-info-soft" style={{ height: `${(p / max) * 100}%` }} />}
                <div className={cn('bg-brand/80 group-hover:bg-brand', p > 0 ? '' : 'rounded-t-sm')} style={{ height: `${(b / max) * 100}%`, minHeight: b ? 2 : 0 }} />
              </div>
              <span className={cn('mt-1 text-xs', active ? 'font-semibold text-brand' : 'text-fg-3')}>{MONTHS_SHORT[i]}</span>
              <span className="tnum truncate whitespace-nowrap text-[11px] leading-tight">{b ? short(b) : '—'}</span>
              {p > 0 && <span className="tnum truncate whitespace-nowrap text-[10px] leading-tight text-info">+{short(p)}</span>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function CategorySummary({ rows, total }: { rows: Array<{ name: string; net: number; vat: number; count: number }>; total: number }) {
  if (!rows.length) return <p className="px-4 py-3 text-sm text-fg-3">Nema podataka.</p>;
  return (
    <table className="data-table compact">
      <thead>
        <tr>
          <th>Kategorija</th>
          <th className="num">Stavki</th>
          <th className="num">Neto</th>
          <th className="num">Udio</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.name}>
            <td>{c.name}</td>
            <td className="num">{c.count}</td>
            <td className="num">{eur(c.net)}</td>
            <td className="num w-32">
              <div className="flex items-center justify-end gap-2">
                <div className="h-1.5 w-14 overflow-hidden rounded bg-muted">
                  <div className="h-full bg-brand" style={{ width: `${total ? (c.net / total) * 100 : 0}%` }} />
                </div>
                <span className="w-10 text-right text-xs text-fg-3">{total ? Math.round((c.net / total) * 100) : 0} %</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
