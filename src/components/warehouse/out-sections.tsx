import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { modelLabel } from '@/server/queries/lookups';
import { outsideItems, reservedGroups, returnCandidates, returningItems } from '@/server/queries/warehouse';
import { Badge, Card, COLOR_TONE, Empty, TableWrap } from '@/components/ui/misc';
import { SelectAll, SelectRow, SelectableTr, SelectionProvider } from '@/components/ui/selection';
import { SearchFilter } from '@/components/ui/filters';
import type { Option } from '@/components/ui/field';
import { AnnounceBar, ReservedBar, ReturningBar } from './out-bars';
import { date, dateTime, eur } from '@/lib/format';
import { num } from '@/domain/money';

const serialLink = (id: string, serial: string) => (
  <Link prefetch={false} href={`/skladiste/${id}`} className="link font-mono text-sm">
    {serial}
  </Link>
);

const partnerLink = (p: { id: string; name: string } | null) =>
  p ? (
    <Link prefetch={false} href={`/partneri/${p.id}`} className="link">
      {p.name}
    </Link>
  ) : (
    <span className="text-fg-4">—</span>
  );

export async function ReservedSection({ companyId, canOps, canSell, canRent, canSeeCost = true }: { companyId: string; canOps: boolean; canSell: boolean; canRent: boolean; canSeeCost?: boolean }) {
  const groups = await reservedGroups(companyId);
  if (!groups.length) return <Empty icon={<Inbox className="size-5" />} title="Nema uređaja koji su izašli iz skladišta" description="Uređaji označeni kao „Izašlo iz skladišta“ čekaju ovdje da prodaja izda račun ili ih doda na ugovor." />;
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <SelectionProvider key={g.partnerId ?? 'none'} ids={g.items.map((i) => i.id)}>
          <Card
            padded={false}
            title={
              <span className="flex items-center gap-2">
                {g.partnerId ? partnerLink({ id: g.partnerId, name: g.partnerName ?? '—' }) : <span className="text-fg-3">Bez navedenog kupca</span>}
                <Badge>{g.items.length} kom</Badge>
              </span>
            }
            actions={canSeeCost ? <span className="text-sm text-fg-3">{eur(g.items.reduce((s, i) => s + num(i.cost), 0))}</span> : undefined}
          >
            <div className="px-3 pt-2">
              <ReservedBar partnerId={g.partnerId} canOps={canOps} canSell={canSell} canRent={canRent} />
            </div>
            <div className="overflow-x-auto scroll-slim">
              <table className="data-table min-w-[760px]">
                <thead>
                  <tr>
                    <th className="w-8">
                      <SelectAll />
                    </th>
                    <th>Serijski broj</th>
                    <th>Model</th>
                    <th>Skladište</th>
                    <th>Izašlo</th>
                    <th>Tko</th>
                    <th>Napomena</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((i) => (
                    <SelectableTr key={i.id} id={i.id}>
                      <td>
                        <SelectRow id={i.id} />
                      </td>
                      <td>{serialLink(i.id, i.serial)}</td>
                      <td>{modelLabel(i.model)}</td>
                      <td>{i.warehouse?.name ?? '—'}</td>
                      <td className="whitespace-nowrap">{dateTime(i.outAt)}</td>
                      <td>{i.outByName ?? '—'}</td>
                      <td className="max-w-72 truncate text-fg-2" title={i.outNote ?? undefined}>
                        {i.outNote ?? ''}
                      </td>
                    </SelectableTr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </SelectionProvider>
      ))}
    </div>
  );
}

export async function ReturnSection({ companyId, canOps }: { companyId: string; canOps: boolean }) {
  const rows = await returnCandidates(companyId);
  if (!rows.length) return <Empty icon={<Inbox className="size-5" />} title="Nema uređaja za povrat" description="Ovdje se pojavljuju uređaji s isteklih ili raskinutih ugovora, kojima je prošla sezona ili istekao plan naplate." />;
  return (
    <SelectionProvider ids={rows.map((r) => r.itemId)}>
      {canOps && <AnnounceBar />}
      <TableWrap>
        <table className="data-table min-w-[820px]">
          <thead>
            <tr>
              <th className="w-8">{canOps && <SelectAll />}</th>
              <th>Serijski broj</th>
              <th>Model</th>
              <th>Klijent</th>
              <th>Ugovor</th>
              <th>Razlog</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <SelectableTr key={r.itemId} id={r.itemId}>
                <td>{canOps && <SelectRow id={r.itemId} />}</td>
                <td>{serialLink(r.itemId, r.serial)}</td>
                <td>{r.model}</td>
                <td>{partnerLink(r.partner)}</td>
                <td>
                  <Link prefetch={false} href={`/najam/ugovori/${r.contractId}`} className="link">
                    {r.contractNumber}
                  </Link>
                </td>
                <td>
                  <Badge tone="warn">{r.reason}</Badge>
                </td>
              </SelectableTr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </SelectionProvider>
  );
}

export async function ReturningSection({ companyId, canOps, warehouses }: { companyId: string; canOps: boolean; warehouses: Option[] }) {
  const rows = await returningItems(companyId);
  if (!rows.length) return <Empty icon={<Inbox className="size-5" />} title="Nema uređaja u dolasku" description="Uređaji s najavljenim povratom čekaju ovdje dok ih ne zaprimite na skladište." />;
  return (
    <SelectionProvider ids={rows.map((r) => r.id)}>
      {canOps && <ReturningBar warehouses={warehouses} />}
      <TableWrap>
        <table className="data-table min-w-[760px]">
          <thead>
            <tr>
              <th className="w-8">{canOps && <SelectAll />}</th>
              <th>Serijski broj</th>
              <th>Model</th>
              <th>Klijent</th>
              <th>Ugovor</th>
              <th>Najavljeno</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <SelectableTr key={r.id} id={r.id}>
                <td>{canOps && <SelectRow id={r.id} />}</td>
                <td>{serialLink(r.id, r.serial)}</td>
                <td>{modelLabel(r.model)}</td>
                <td>{partnerLink(r.partner)}</td>
                <td>
                  {r.contractItem ? (
                    <Link prefetch={false} href={`/najam/ugovori/${r.contractItem.contract.id}`} className="link">
                      {r.contractItem.contract.number}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="whitespace-nowrap">{date(r.updatedAt)}</td>
              </SelectableTr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </SelectionProvider>
  );
}

export async function ManualReturnSection({ companyId, canOps, q }: { companyId: string; canOps: boolean; q: string | null }) {
  const rows = await outsideItems(companyId, q);
  return (
    <>
      <div className="mb-3">
        <SearchFilter placeholder="Serijski broj uređaja izvan skladišta…" />
        <p className="mt-1 text-sm text-fg-3">Traže se prodani, iznajmljeni i ostali uređaji izvan skladišta.</p>
      </div>
      {!q ? null : rows.length ? (
        <SelectionProvider ids={rows.map((r) => r.id)}>
          {canOps && <AnnounceBar />}
          <TableWrap>
            <table className="data-table min-w-[720px]">
              <thead>
                <tr>
                  <th className="w-8">{canOps && <SelectAll />}</th>
                  <th>Serijski broj</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Klijent</th>
                  <th>Izdano</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <SelectableTr key={r.id} id={r.id}>
                    <td>{canOps && <SelectRow id={r.id} />}</td>
                    <td>
                      {serialLink(r.id, r.serial)}
                      {r.dupNote && <span className="ml-1.5 text-xs text-warn">({r.dupNote})</span>}
                    </td>
                    <td>{modelLabel(r.model)}</td>
                    <td>
                      <Badge tone={COLOR_TONE[r.status.color] ?? 'neutral'}>{r.status.name}</Badge>
                    </td>
                    <td>{partnerLink(r.partner)}</td>
                    <td className="whitespace-nowrap">{date(r.issueDate)}</td>
                  </SelectableTr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </SelectionProvider>
      ) : (
        <Empty icon={<Inbox className="size-5" />} title="Nema uređaja izvan skladišta s tim serijskim brojem" />
      )}
    </>
  );
}
