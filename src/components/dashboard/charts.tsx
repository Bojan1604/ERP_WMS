import { Legend } from '@/components/charts/legend';
import { SLOT_BG, SLOT_FILL, SLOT_STROKE, compact, niceTicks } from '@/components/charts/palette';
import { amount, integer } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * Prsten (pita) uređaja po statusu — iscrtan na poslužitelju. Sitni udjeli (< 2 %)
 * idu u „Ostalo" da graf ostane čitljiv; točni brojevi su u legendi.
 */
export function DonutChart({ data, className }: { data: Array<{ label: string; value: number; href?: string }>; className?: string }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  if (!total) return <p className="text-sm text-fg-3">Nema uređaja.</p>;
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const big = sorted.filter((d, i) => i < 7 && d.value / total >= 0.02);
  const rest = sorted.filter((d) => !big.includes(d));
  const parts = rest.length ? [...big, { label: 'Ostalo', value: rest.reduce((a, d) => a + d.value, 0) }] : big;
  const R = 70;
  const r = 44;
  const C = 90;
  let angle = -Math.PI / 2;
  const arcs = parts.map((p, i) => {
    const a0 = angle;
    const sweep = (p.value / total) * Math.PI * 2;
    angle += sweep;
    const a1 = angle - (parts.length > 1 ? 0.012 : 0);
    const large = sweep > Math.PI ? 1 : 0;
    const pt = (rad: number, ang: number) => `${C + rad * Math.cos(ang)},${C + rad * Math.sin(ang)}`;
    const d =
      parts.length === 1
        ? `M${C - R},${C}a${R},${R} 0 1,0 ${2 * R},0a${R},${R} 0 1,0 ${-2 * R},0M${C - r},${C}a${r},${r} 0 1,1 ${2 * r},0a${r},${r} 0 1,1 ${-2 * r},0`
        : `M${pt(R, a0)}A${R},${R} 0 ${large} 1 ${pt(R, a1)}L${pt(r, a1)}A${r},${r} 0 ${large} 0 ${pt(r, a0)}z`;
    return { ...p, d, slot: i };
  });
  return (
    <div className={cn('flex flex-col items-center gap-3 sm:flex-row sm:items-center', className)}>
      <svg viewBox="0 0 180 180" className="size-40 shrink-0" role="img" aria-label={`Uređaji po statusu: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
        {arcs.map((a) => (
          <path key={a.label} d={a.d} fillRule="evenodd" className={SLOT_FILL[a.slot % 8]}>
            <title>{`${a.label}: ${integer(a.value)} (${Math.round((a.value / total) * 1000) / 10} %)`}</title>
          </path>
        ))}
        {/* dulji zapis („270,5 tis.") manjim slovima — ne smije dodirivati prsten (unutarnji promjer 88) */}
        <text x={C} y={C - 4} textAnchor="middle" className={cn('fill-fg font-semibold tnum', compact(total).length <= 5 ? 'text-[18px]' : compact(total).length <= 7 ? 'text-[15px]' : 'text-[12.5px]')}>
          {compact(total)}
        </text>
        <text x={C} y={C + 14} textAnchor="middle" className="fill-fg-3 text-[10px]">
          uređaja
        </text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1 text-sm">
        {sorted.map((d) => {
          const slot = arcs.find((a) => a.label === d.label)?.slot ?? arcs.length - 1;
          return (
            <li key={d.label} className="flex items-center gap-2">
              <span className={cn('size-2.5 shrink-0 rounded-sm', SLOT_BG[slot % 8])} />
              {d.href ? (
                <a href={d.href} className="min-w-0 flex-1 truncate hover:underline">
                  {d.label}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate">{d.label}</span>
              )}
              <span className="tnum text-fg-2">{integer(d.value)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const M = { top: 10, right: 8, bottom: 22, left: 52 };

/** Stupci prihoda po mjesecima i krivulja bruto dobiti (prihod − nabavna vrijednost prodanog) preko njih. */
export function RevenueProfitChart({
  data,
  width: W = 800,
  height: H = 240,
  className,
}: {
  data: Array<{ label: string; title: string; revenue: number; profit: number | null }>;
  width?: number;
  height?: number;
  className?: string;
}) {
  const showProfit = data.some((d) => d.profit !== null);
  const values = data.flatMap((d) => [d.revenue, d.profit ?? 0]);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(1, ...values), 4);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const y = (v: number) => M.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const band = plotW / data.length;
  const barW = Math.min(26, band * 0.55);
  const cx = (i: number) => M.left + i * band + band / 2;
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${cx(i)},${y(d.profit ?? 0)}`).join('');
  const fmt = (v: number) => `${amount(v)} €`;
  return (
    <figure className={cn('min-w-0', className)}>
      <Legend className="mb-2" items={[{ label: 'Prihod', slot: 0 }, ...(showProfit ? [{ label: 'Dobit od prodaje', slot: 2, line: true }] : [])]} />
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" role="img" aria-label="Prihod i dobit po mjesecima">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'stroke-line-strong' : 'stroke-line'} strokeWidth={1} />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-fg-3 text-[11px] tnum">
              {compact(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const top = Math.min(y(0), y(d.revenue));
          const h = Math.abs(y(d.revenue) - y(0));
          return (
            <g key={i}>
              {h > 0.5 && <rect x={cx(i) - barW / 2} y={top} width={barW} height={h} rx={3} className={SLOT_FILL[0]} />}
              <text x={cx(i)} y={H - 6} textAnchor="middle" className="fill-fg-3 text-[11px]">
                {d.label}
              </text>
              <title>{`${d.title}: prihod ${fmt(d.revenue)}${d.profit !== null ? `, dobit ${fmt(d.profit)}` : ''}`}</title>
            </g>
          );
        })}
        {showProfit && (
          <>
            <path d={line} fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" className={SLOT_STROKE[2]} />
            {data.map((d, i) => (
              <circle key={i} cx={cx(i)} cy={y(d.profit ?? 0)} r={3} className={cn(SLOT_FILL[2], 'stroke-panel')} strokeWidth={1.5}>
                <title>{`${d.title}: dobit ${fmt(d.profit ?? 0)}`}</title>
              </circle>
            ))}
          </>
        )}
      </svg>
    </figure>
  );
}
