import Link from 'next/link';
import type { Contract } from '@prisma/client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { TableWrap } from '@/components/ui/misc';
import { contractAccrual, contractBilling, scheduledCharges } from '@/domain/billing';
import { MONTHS_SHORT, periodLabel, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { toDevice, toTerms } from '@/server/services/rentals';
import type { contractItems } from '@/server/queries/rentals';
import { amount, eur } from '@/lib/format';
import { cn } from '@/lib/cn';
import { db } from '@/server/db';
import { coveredPeriods } from '@/server/services/invoices';
import { PauseCell } from '@/components/rentals/pause-cell';
import { pausePeriodAction } from '../actions';

type Items = Awaited<ReturnType<typeof contractItems>>;

/** Raspored naplate kroz godinu: rata po uređaju i mjesecu, uz obračun i naplatu ugovora. */
export async function ScheduleTab({ contract: c, items, year: y, canEdit }: { contract: Contract; items: Items; year?: number; canEdit: boolean }) {
  const now = today();
  const cy = Number(now.slice(0, 4));
  const year = y && y > 1990 && y < 2200 ? y : cy;
  const cm = year === cy ? Number(now.slice(5, 7)) - 1 : -1;
  const terms = toTerms(c);
  const devices = items.map(toDevice);
  const covered = (await coveredPeriods(db, [c.id])).get(c.id) ?? new Set<string>();
  // ćelija = rata u mjesecu naplate; pauzirane se prikazuju precrtane i ne ulaze u zbroj
  const rows = items.map((i, k) => {
    const d = devices[k];
    const paused = new Set(d.paused ?? []);
    const cells = Array.from({ length: 12 }, () => ({ v: 0, period: '', paused: false, invoiced: false }));
    for (const ch of scheduledCharges(terms, d, `${year}-01`, `${year}-12`)) {
      const cell = cells[Number(ch.period.slice(5, 7)) - 1];
      cell.v = r2(cell.v + ch.amount);
      cell.period = ch.period;
      cell.paused = paused.has(ch.period);
      cell.invoiced = covered.has(`${d.itemId}|${ch.period}`);
    }
    const total = r2(cells.reduce((a, x) => a + (x.paused ? 0 : x.v), 0));
    return { id: i.id, serial: i.item.serial, itemId: i.item.id, monthly: num(i.monthly), cells, total };
  });
  const billing = contractBilling(terms, devices, year);
  const accrual = contractAccrual(terms, devices, year);
  const sum = (a: number[]) => r2(a.reduce((x, v) => x + v, 0));
  const base = `/najam/ugovori/${c.id}?tab=raspored&godina=`;
  const hl = (m: number) => m === cm && 'bg-info-soft';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link prefetch={false} href={`${base}${year - 1}`} className="grid size-7 place-items-center rounded-md border border-line-strong bg-panel hover:bg-muted" aria-label="Prethodna godina">
            <ChevronLeft className="size-4" />
          </Link>
          <span className="text-md font-semibold tnum">{year}.</span>
          <Link prefetch={false} href={`${base}${year + 1}`} className="grid size-7 place-items-center rounded-md border border-line-strong bg-panel hover:bg-muted" aria-label="Sljedeća godina">
            <ChevronRight className="size-4" />
          </Link>
        </div>
        <p className="text-sm text-fg-3">
          U ćelijama je <b>iznos rate</b> u mjesecu naplate. Obračun je mjesečni iznos uređaja koji su taj mjesec u najmu.
          {canEdit && <> Klik na iznos <b>pauzira naplatu</b> tog uređaja u tom mjesecu (precrtano = ne naplaćuje se); podebljano = fakturirano.</>}
        </p>
      </div>
      <TableWrap>
        <table className="data-table no-stack compact [&_td]:whitespace-nowrap">
          <thead>
            <tr>
              <th className="sticky left-0 z-[2] bg-panel-2">Uređaj</th>
              <th className="num">Mjesečno</th>
              {MONTHS_SHORT.map((m, i) => (
                <th key={m} className={cn('num', hl(i))}>
                  {m}
                </th>
              ))}
              <th className="num">Ukupno</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="sticky left-0 z-[1] bg-panel">
                  <Link prefetch={false} href={`/skladiste/${r.itemId}`} className="link font-mono text-sm">
                    {r.serial}
                  </Link>
                </td>
                <td className="num">{amount(r.monthly)}</td>
                {r.cells.map((x, i) => (
                  <td key={i} className={cn('num', hl(i), !x.v && 'text-fg-4', canEdit && x.v && !x.invoiced && 'p-0')} title={x.invoiced ? 'Fakturirano' : undefined}>
                    {!x.v ? (
                      '·'
                    ) : canEdit && !x.invoiced ? (
                      <PauseCell action={pausePeriodAction} contractId={c.id} itemId={r.itemId} serial={r.serial} period={x.period} label={periodLabel(x.period)} value={x.v} paused={x.paused} />
                    ) : (
                      <span className={cn(x.paused && 'text-warn line-through', x.invoiced && 'font-medium')}>{amount(x.v)}</span>
                    )}
                  </td>
                ))}
                <td className="num font-medium">{amount(r.total)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={15} className="py-6 text-center text-fg-3">
                  Na ugovoru nema uređaja.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky left-0 z-[1]">Naplata (rate)</td>
              <td className="num">{amount(sum(rows.map((r) => r.monthly)))}</td>
              {billing.map((v, i) => (
                <td key={i} className={cn('num', hl(i))}>
                  {v ? amount(v) : '·'}
                </td>
              ))}
              <td className="num">{eur(sum(billing))}</td>
            </tr>
            <tr>
              <td className="sticky left-0 z-[1] font-normal text-fg-2">Obračun (mjesečno)</td>
              <td />
              {accrual.map((v, i) => (
                <td key={i} className={cn('num font-normal text-fg-2', hl(i))}>
                  {v ? amount(v) : '·'}
                </td>
              ))}
              <td className="num font-normal text-fg-2">{eur(sum(accrual))}</td>
            </tr>
          </tfoot>
        </table>
      </TableWrap>
    </div>
  );
}
