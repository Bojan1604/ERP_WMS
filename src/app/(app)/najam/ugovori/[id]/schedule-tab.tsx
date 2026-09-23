import Link from 'next/link';
import type { Contract } from '@prisma/client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { TableWrap } from '@/components/ui/misc';
import { contractAccrual, contractBilling, deviceChargesInYear } from '@/domain/billing';
import { MONTHS_SHORT, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { toDevice, toTerms } from '@/server/services/rentals';
import type { contractItems } from '@/server/queries/rentals';
import { amount, eur } from '@/lib/format';
import { cn } from '@/lib/cn';

type Items = Awaited<ReturnType<typeof contractItems>>;

/** Raspored naplate kroz godinu: rata po uređaju i mjesecu, uz obračun i naplatu ugovora. */
export function ScheduleTab({ contract: c, items, year: y }: { contract: Contract; items: Items; year?: number }) {
  const now = today();
  const cy = Number(now.slice(0, 4));
  const year = y && y > 1990 && y < 2200 ? y : cy;
  const cm = year === cy ? Number(now.slice(5, 7)) - 1 : -1;
  const terms = toTerms(c);
  const devices = items.map(toDevice);
  const rows = items.map((i, k) => {
    const cells = Array<number>(12).fill(0);
    for (const ch of deviceChargesInYear(terms, devices[k], year)) cells[Number(ch.period.slice(5, 7)) - 1] += ch.amount;
    return { id: i.id, serial: i.item.serial, itemId: i.item.id, monthly: num(i.monthly), cells: cells.map(r2), total: r2(cells.reduce((a, b) => a + b, 0)) };
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
        </p>
      </div>
      <TableWrap>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Uređaj</th>
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
                <td>
                  <Link prefetch={false} href={`/skladiste/${r.itemId}`} className="link font-mono text-sm">
                    {r.serial}
                  </Link>
                </td>
                <td className="num">{amount(r.monthly)}</td>
                {r.cells.map((v, i) => (
                  <td key={i} className={cn('num', hl(i), !v && 'text-fg-4')}>
                    {v ? amount(v) : '·'}
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
              <td>Naplata (rate)</td>
              <td className="num">{amount(sum(rows.map((r) => r.monthly)))}</td>
              {billing.map((v, i) => (
                <td key={i} className={cn('num', hl(i))}>
                  {v ? amount(v) : '·'}
                </td>
              ))}
              <td className="num">{eur(sum(billing))}</td>
            </tr>
            <tr>
              <td className="font-normal text-fg-2">Obračun (mjesečno)</td>
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
