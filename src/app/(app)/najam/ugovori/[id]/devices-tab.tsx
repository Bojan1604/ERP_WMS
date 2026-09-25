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
import { deviceCandidates, hideCostSource, type contractItems } from '@/server/queries/rentals';
import { eur, integer } from '@/lib/format';
import { SearchFilter } from '@/components/ui/filters';
import { Pagination } from '@/components/ui/pagination';
import { plural } from '@/domain/plural';

/** Iznad toga uređaji se prikazuju po stranicama (tablica s tisuću redaka je spora u pregledniku). */
const PAGE = 250;

type Items = Awaited<ReturnType<typeof contractItems>>;

export async function DevicesTab({
  contract: c,
  items,
  canEdit,
  companyId,
  prefill,
  params,
  showCost,
}: {
  contract: Contract & { partner: { name: string } };
  items: Items;
  canEdit: boolean;
  companyId: string;
  prefill: string;
  params: Record<string, string | string[] | undefined>;
  /** Pravo na nabavne cijene (izvor prijedloga cijene „% nabavne"). */
  showCost: boolean;
}) {
  const terms = toTerms(c);
  const now = today();
  const ids = prefill ? prefill.split(',').filter(Boolean).slice(0, 500) : [];
  const initial = canEdit && ids.length ? hideCostSource(await deviceCandidates(companyId, c.id, { ids, limit: 500 }), showCost) : [];
  const total = r2(items.reduce((a, i) => a + num(i.monthly), 0));
  const defaultFrom = `${now.slice(0, 7)}-01`;
  const q = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const found = q
    ? items.filter((i) => [i.item.serial, i.item.model.brand, i.item.model.name, i.item.model.category?.name].some((v) => v?.toLowerCase().includes(q)))
    : items;
  const paged = items.length > PAGE;
  const page = paged ? Math.min(Math.max(1, Number(params.page) || 1), Math.max(1, Math.ceil(found.length / PAGE))) : 1;
  const shown = paged ? found.slice((page - 1) * PAGE, page * PAGE) : found;

  return (
    <SelectionProvider ids={shown.map((i) => i.id)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-3">
          Uređaj bez vlastitog plana slijedi uvjete ugovora. Uklonjeni uređaji ostaju na ugovoru „U dolasku" dok ih skladište ne zaprimi.
        </p>
        {items.length > 20 && <SearchFilter placeholder="Serijski broj, model…" />}
        {canEdit && <AddDevicesDialog contractId={c.id} partnerName={c.partner.name} initial={initial} defaultFrom={defaultFrom} startOpen={initial.length > 0} />}
      </div>
      {canEdit && (
        <DeviceBulkBar
          contractId={c.id}
          defaultFrom={defaultFrom}
          devices={shown.map((i) => ({
            id: i.id,
            serial: i.item.serial,
            monthly: num(i.monthly),
            plan: toDevice(i).plan ?? [],
            paused: i.status === 'PAUSED',
            rented: i.item.state === 'RENTED',
          }))}
        />
      )}
      {shown.length ? (
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
              {shown.map((i) => {
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
                <td colSpan={3}>{integer(items.length)} {plural(items.length, 'uređaj', 'uređaja', 'uređaja')}{q ? ` (pronađeno ${integer(found.length)})` : ''}</td>
                <td className="num">{eur(total)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </TableWrap>
      ) : null}
      {paged && <Pagination page={page} pageSize={PAGE} total={found.length} params={params} basePath={`/najam/ugovori/${c.id}`} />}
      {q && !found.length && items.length ? (
        <TableWrap>
          <Empty icon={<Boxes className="size-5" />} title="Nema uređaja za ovu pretragu" />
        </TableWrap>
      ) : null}
      {!items.length ? (
        <TableWrap>
          <Empty icon={<Boxes className="size-5" />} title="Na ugovoru nema uređaja" description={canEdit ? 'Dodajte uređaje sa skladišta ili one koji su već kod klijenta.' : undefined} />
        </TableWrap>
      ) : null}
    </SelectionProvider>
  );
}
