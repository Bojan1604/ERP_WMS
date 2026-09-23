import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { amount } from '@/lib/format';
import { Legend } from './legend';
import { SLOT_FILL, SLOT_STROKE, compact, niceTicks } from './palette';

export interface ChartSeries {
  key: string;
  label: string;
  /** Mjesto u kategorijskoj paleti (zadano: redni broj serije). */
  slot?: number;
}

export interface ChartDatum {
  /** Kratka oznaka na osi (npr. „ožu"). */
  label: string;
  /** Puni naziv u oblačiću (npr. „ožujak 2026."). */
  title?: string;
  values: Record<string, number>;
}

const M = { top: 10, right: 8, bottom: 22, left: 52 };
const BAR = 24;
const GAP = 2;

/** Stupac s 4 px zaobljenim krajem podatka, ravan uz osnovicu. */
function barPath(x: number, y0: number, y1: number, w: number, round: boolean): string {
  const top = Math.min(y0, y1);
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const up = y1 < y0; // pozitivna vrijednost raste prema gore
  const r = round ? Math.min(4, h, w / 2) : 0;
  if (!r) return `M${x},${top}h${w}v${h}h${-w}z`;
  if (up) {
    return `M${x},${top + h}v${-(h - r)}q0,${-r} ${r},${-r}h${w - 2 * r}q${r},0 ${r},${r}v${h - r}z`;
  }
  return `M${x},${top}h${w}v${h - r}q0,${r} ${-r},${r}h${-(w - 2 * r)}q${-r},0 ${-r},${-r}z`;
}

/**
 * Stupčasti graf iscrtan na poslužitelju. `stacked` slaže serije u jedan
 * stupac (s razmakom od 2 px između dijelova), inače stoje jedna do druge.
 * Prelazak mišem ili fokus na stupcu prikazuje oblačić sa svim serijama.
 */
export function BarChart({
  data,
  series,
  stacked = true,
  height = 220,
  format = (v: number) => `${amount(v)} €`,
  showTotal = true,
  className,
  ariaLabel,
  width: W = 800,
}: {
  data: ChartDatum[];
  series: ChartSeries[];
  stacked?: boolean;
  height?: number;
  format?: (v: number) => string;
  showTotal?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Širina koordinatnog sustava — veća za široke stranice, da tekst ne bude prevelik. */
  width?: number;
}) {
  const slots = series.map((s, i) => s.slot ?? i);
  const H = height;
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  let lo = 0;
  let hi = 0;
  for (const d of data) {
    if (stacked) {
      let pos = 0;
      let neg = 0;
      for (const s of series) {
        const v = d.values[s.key] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    } else {
      for (const s of series) {
        const v = d.values[s.key] ?? 0;
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
    }
  }
  const ticks = niceTicks(lo, hi || 1, 4);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const y = (v: number) => M.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const band = plotW / Math.max(1, data.length);
  const groupW = stacked ? Math.min(BAR, band * 0.6) : Math.min(series.length * (BAR + GAP), band * 0.8);
  const barW = stacked ? groupW : Math.max(2, groupW / series.length - GAP);

  return (
    <figure className={cn('min-w-0', className)}>
      {series.length > 1 && <Legend className="mb-2" items={series.map((s, i) => ({ label: s.label, slot: slots[i] }))} />}
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" role="img" aria-label={ariaLabel}>
        {/* mreža i os */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'stroke-line-strong' : 'stroke-line'} strokeWidth={1} />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-fg-3 text-[11px] tnum">
              {compact(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 = M.left + i * band + (band - groupW) / 2;
          const bars: ReactNode[] = [];
          if (stacked) {
            let pos = 0;
            let neg = 0;
            const vals = series.map((s) => d.values[s.key] ?? 0);
            const lastPos = vals.map((v, k) => (v > 0 ? k : -1)).filter((k) => k >= 0).at(-1);
            const lastNeg = vals.map((v, k) => (v < 0 ? k : -1)).filter((k) => k >= 0).at(-1);
            vals.forEach((v, k) => {
              if (!v) return;
              const base = v > 0 ? pos : neg;
              const end = base + v;
              if (v > 0) pos = end;
              else neg = end;
              // razmak površine između složenih dijelova
              const gap = base !== 0 ? (v > 0 ? -GAP : GAP) : 0;
              bars.push(
                <path key={series[k].key} d={barPath(x0, y(base) + gap, y(end), barW, k === (v > 0 ? lastPos : lastNeg))} className={SLOT_FILL[slots[k] % 8]} />,
              );
            });
          } else {
            series.forEach((s, k) => {
              const v = d.values[s.key] ?? 0;
              if (!v) return;
              bars.push(<path key={s.key} d={barPath(x0 + k * (barW + GAP), y(0), y(v), barW, true)} className={SLOT_FILL[slots[k] % 8]} />);
            });
          }
          return (
            <g key={i}>
              {bars}
              <text x={M.left + i * band + band / 2} y={H - 6} textAnchor="middle" className="fill-fg-3 text-[11px]">
                {d.label}
              </text>
            </g>
          );
        })}
        {/* sloj za prelazak mišem — iznad svih stupaca, da oblačić ništa ne prekrije */}
        {data.map((d, i) => (
          <g key={i} className="group outline-none" tabIndex={0} aria-label={`${d.title ?? d.label}: ${series.map((s) => `${s.label} ${format(d.values[s.key] ?? 0)}`).join(', ')}`}>
            <rect x={M.left + i * band} y={M.top} width={band} height={plotH} className="fill-transparent group-hover:fill-fg/5 group-focus:fill-fg/5" />
            <Tooltip datum={d} series={series} slots={slots} format={format} showTotal={showTotal && stacked && series.length > 1} anchorX={M.left + i * band} band={band} width={W} />
          </g>
        ))}
      </svg>
    </figure>
  );
}

function Tooltip({
  datum,
  series,
  slots,
  format,
  showTotal,
  anchorX,
  band,
  width: W,
}: {
  datum: ChartDatum;
  series: ChartSeries[];
  slots: number[];
  format: (v: number) => string;
  showTotal: boolean;
  anchorX: number;
  band: number;
  width: number;
}) {
  const rows = series.map((s, k) => ({ label: s.label, value: datum.values[s.key] ?? 0, slot: slots[k] }));
  const total = rows.reduce((a, r) => a + r.value, 0);
  const lines = rows.map((r) => `${format(r.value)}  ${r.label}`);
  const title = datum.title ?? datum.label;
  const longest = Math.max(title.length, ...lines.map((l) => l.length + 3), showTotal ? format(total).length + 8 : 0);
  const w = Math.max(120, longest * 6.4 + 20);
  const h = 26 + rows.length * 17 + (showTotal ? 19 : 0);
  let x = anchorX + band + 4;
  if (x + w > W) x = anchorX - w - 4;
  if (x < 0) x = 2;
  const y = M.top + 4;
  return (
    <g className="pointer-events-none opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100">
      <rect x={x} y={y} width={w} height={h} rx={6} className="fill-panel stroke-line-strong" strokeWidth={1} />
      <text x={x + 10} y={y + 17} className="fill-fg-2 text-[11px] font-medium">
        {title}
      </text>
      {rows.map((r, k) => (
        <g key={r.label}>
          <line x1={x + 10} x2={x + 20} y1={y + 32 + k * 17} y2={y + 32 + k * 17} strokeWidth={2} strokeLinecap="round" className={SLOT_STROKE[r.slot % 8]} />
          <text x={x + 26} y={y + 36 + k * 17} className="text-[11.5px]">
            <tspan className="fill-fg font-semibold tnum">{format(r.value)}</tspan>
            <tspan className="fill-fg-3"> {r.label}</tspan>
          </text>
        </g>
      ))}
      {showTotal && (
        <text x={x + 10} y={y + 38 + rows.length * 17} className="text-[11.5px]">
          <tspan className="fill-fg-3">Ukupno </tspan>
          <tspan className="fill-fg font-semibold tnum">{format(total)}</tspan>
        </text>
      )}
    </g>
  );
}
