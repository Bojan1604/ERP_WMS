import Link from 'next/link';
import type { Contract } from '@prisma/client';
import { Boxes } from 'lucide-react';
import { Badge, Empty, TableWrap } from '@/components/ui/misc';
import { SelectAll, SelectRow, SelectableTr, SelectionProvider } from '@/components/ui/selection';
import { ItemStatusBadge } from '@/components/rentals/badges';
import { DeviceBulkBar } from '@/components/rentals/device-actions';
import { AddDevicesDialog } from '@/components/rentals/add-devices-dialog';
import { hasCustomPlan, planSummary, returnReason } from '@/domain/billing';
import { today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { toDevice, toTerms } from '@/server/services/rentals';
import { deviceCandidates, type contractItems } from '@/server/queries/rentals';
import { eur } from '@/lib/format';

type Items = Awaited<ReturnType<typeof contractItems>>;

export async function DevicesTab({
  contract: c,
  items,
  canEdit,
  companyId,
  prefill,
}: {
  contract: Contract & { partner: { name: string } };
  items: Items;
  canEdit: boolean;
  companyId: string;
  prefill: string;
}) {
  const terms = toTerms(c);
  const now = today();
  const ids = prefill ? prefill.split(',').filter(Boolean).slice(0, 500) : [];
  const initial = canEdit && ids.length ? await deviceCandidates(companyId, c.id, { ids, limit: 500 }) : [];
  const total = r2(items.reduce((a, i) => a + num(i.monthly), 0));
  const defaultFrom = `${now.slice(0, 7)}-01`;

  return (
    <SelectionProvider ids={items.map((i) => i.id)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-3">
          Uređaj bez vlastitog plana slijedi uvjete ugovora. Uklonjeni uređaji ostaju na ugovoru „U dolasku" dok ih skladište ne zaprimi.
        </p>
        {canEdit && <AddDevicesDialog contractId={c.id} partnerName={c.partner.name} initial={initial} defaultFrom={defaultFrom} startOpen={initial.length > 0} />}
      </div>
      {canEdit && (
        <DeviceBulkBar
          contractId={c.id}
          defaultFrom={defaultFrom}
          devices={items.map((i) => ({
            id: i.id,
            serial: i.item.serial,
            monthly: num(i.monthly),
            plan: toDevice(i).plan ?? [],
            paused: i.status === 'PAUSED',
            rented: i.item.state === 'RENTED',
          }))}
        />
      )}
      {items.length ? (
        <TableWrap>
          <table className="data-table">
            <thead>
              <tr>
                {canEdit && (
                  <th className="w-8">
                    <SelectAll />
                  </th>
                )}
                <th>Serijski broj</th>
                <th>Model</th>
                <th>Kategorija</th>
                <th className="num">Mjesečno</th>
                <th>Plan naplate</th>
                <th>Na ugovoru</th>
                <th>Status uređaja</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const d = toDevice(i);
                const reason = i.item.state === 'RENTED' ? returnReason(terms, d, now) : null;
                return (
                  <SelectableTr key={i.id} id={i.id}>
                    {canEdit && (
                      <td>
                        <SelectRow id={i.id} />
                      </td>
                    )}
                    <td>
                      <Link prefetch={false} href={`/skladiste/${i.item.id}`} className="link font-mono text-sm">
                        {i.item.serial}
                      </Link>
                    </td>
                    <td>{[i.item.model.brand, i.item.model.name].filter(Boolean).join(' ')}</td>
                    <td className="text-fg-2">{i.item.model.category?.name ?? '—'}</td>
                    <td className="num font-medium">{eur(num(i.monthly))}</td>
                    <td>
                      <span className="text-sm">{planSummary(terms, d)}</span>
                      {hasCustomPlan(d) && d.plan?.length ? (
                        <Badge className="ml-1.5" tone="brand" title="Vlastiti plan naplate, različit od ugovora">
                          vlastito
                        </Badge>
                      ) : null}
                      {d.skipped?.length ? (
                        <Badge className="ml-1.5" title={`Izdano izvan programa: ${d.skipped.join(', ')}`}>
                          preskočeno {d.skipped.length}
                        </Badge>
                      ) : null}
                    </td>
                    <td>
                      {i.status === 'PAUSED' ? <Badge tone="warn">Pauziran</Badge> : i.status === 'TERMINATED' ? <Badge tone="bad">Raskinut</Badge> : <span className="text-sm text-fg-3">prati ugovor</span>}
                      {reason && (
                        <Badge className="ml-1.5" tone="warn" title="Uređaj bi trebalo vratiti s terena">
                          {reason}
                        </Badge>
                      )}
                    </td>
                    <td>
                      <ItemStatusBadge name={i.item.status.name} color={i.item.status.color} />
                    </td>
                  </SelectableTr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                {canEdit && <td />}
                <td colSpan={3}>{items.length} uređaja</td>
                <td className="num">{eur(total)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </TableWrap>
      ) : (
        <TableWrap>
          <Empty icon={<Boxes className="size-5" />} title="Na ugovoru nema uređaja" description={canEdit ? 'Dodajte uređaje sa skladišta ili one koji su već kod klijenta.' : undefined} />
        </TableWrap>
      )}
    </SelectionProvider>
  );
}
