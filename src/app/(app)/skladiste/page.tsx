import Link from 'next/link';
import { Download, PackagePlus, Boxes, ScanLine, ClipboardCheck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getLookups, modelLabel } from '@/server/queries/lookups';
import { importYears, listItems, parseItemFilters } from '@/server/queries/warehouse';
import { can } from '@/domain/permissions';
import { num } from '@/domain/money';
import { PageHeader, Badge, COLOR_TONE, TableWrap, Empty } from '@/components/ui/misc';
import { FilterBar, SearchFilter, SelectFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { SelectionProvider, SelectAll, SelectRow, SelectableTr } from '@/components/ui/selection';
import { LinkButton, buttonClass } from '@/components/ui/button';
import { ComboFilter } from '@/components/warehouse/pickers';
import { ItemBulkBar, type RowMeta } from '@/components/warehouse/item-bulk-bar';
import { ItemCards, ScanFab } from '@/components/warehouse/item-cards';
import { STATE_LABEL, STATE_ORDER } from '@/domain/warehouse';
import { cn } from '@/lib/cn';
import { date, eur, integer } from '@/lib/format';

type Params = Record<string, string | string[] | undefined>;

const FILTER_KEYS = ['q', 'status', 'state', 'model', 'category', 'warehouse', 'supplier', 'partner', 'year'];

function hrefWith(sp: Params, patch: Record<string, string | null>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v && k !== 'page') q.set(k, v);
  for (const [k, v] of Object.entries(patch)) (v ? q.set(k, v) : q.delete(k));
  const s = q.toString();
  return s ? `/skladiste?${s}` : '/skladiste';
}

export default async function WarehousePage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('warehouse', 'view');
  const sp = await searchParams;
  const f = parseItemFilters(sp);
  const pg = readPage(sp, 50);
  const c = user.companyId;

  const [list, lookups, years, company, partnerCur, supplierCur] = await Promise.all([
    listItems(c, f, pg),
    getLookups(c),
    importYears(c),
    db.company.findUniqueOrThrow({ where: { id: c }, select: { statusChangeNeedsApproval: true } }),
    f.partnerId ? db.partner.findFirst({ where: { id: f.partnerId, companyId: c }, select: { id: true, name: true } }) : null,
    f.supplierId ? db.partner.findFirst({ where: { id: f.supplierId, companyId: c }, select: { id: true, name: true } }) : null,
  ]);

  const perms = { canEdit: can(user.perms, 'warehouse', 'edit'), canOps: can(user.perms, 'warehouse', 'ops'), needsApproval: company.statusChangeNeedsApproval };
  const options = {
    statuses: lookups.statuses.map((s) => ({ id: s.id, name: s.name, kind: s.kind, color: s.color })),
    warehouses: lookups.warehouses.map((w) => ({ value: w.id, label: w.name })),
    models: lookups.models.map((m) => ({ value: m.id, label: modelLabel(m) })),
  };
  const rowMeta: Record<string, RowMeta> = Object.fromEntries(
    list.rows.map((r) => [r.id, { state: r.state, onContract: !!r.contractItem, cost: num(r.cost) }]),
  );
  const exportQs = new URLSearchParams();
  for (const k of FILTER_KEYS) if (typeof sp[k] === 'string' && sp[k]) exportQs.set(k, sp[k] as string);
  const filtered = FILTER_KEYS.some((k) => typeof sp[k] === 'string' && sp[k]);
  const allCount = Object.values(list.counts).reduce((a, b) => a + (b ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Skladište"
        subtitle="Uređaji po serijskim brojevima"
        actions={
          <>
            <LinkButton href="/skladiste/skeniranje" icon={<ScanLine className="size-4" />} className="max-sm:hidden">
              Skeniranje
            </LinkButton>
            <LinkButton href="/skladiste/inventura" icon={<ClipboardCheck className="size-4" />} className="max-sm:hidden">
              Inventura
            </LinkButton>
            <a href={`/api/skladiste/izvoz?${exportQs}`} className={buttonClass('secondary')}>
              <Download className="size-4" />
              Izvoz CSV
            </a>
            {perms.canEdit && (
              <LinkButton href="/skladiste/zaprimanje" variant="primary" icon={<PackagePlus className="size-4" />}>
                Zaprimanje
              </LinkButton>
            )}
          </>
        }
      />

      <div className="no-print mb-3 flex flex-wrap gap-1.5">
        <Link prefetch={false} href={hrefWith(sp, { state: null })} className={chip(!f.state)}>
          Sve <span className="tnum opacity-70">{integer(allCount)}</span>
        </Link>
        {STATE_ORDER.filter((s) => list.counts[s]).map((s) => (
          <Link prefetch={false} key={s} href={hrefWith(sp, { state: f.state === s ? null : s })} className={chip(f.state === s)}>
            {STATE_LABEL[s]} <span className="tnum opacity-70">{integer(list.counts[s] ?? 0)}</span>
          </Link>
        ))}
      </div>

      <FilterBar>
        <SearchFilter placeholder="Serijski, model, napomena, klijent…" />
        {/* na mobitelu dva filtra u retku, na većem zaslonu jedan niz */}
        <div className="grid w-full grid-cols-2 gap-2 sm:contents">
        <SelectFilter name="status" placeholder="Svi statusi" options={options.statuses.map((s) => ({ value: s.id, label: s.name }))} />
        <ComboFilter name="model" placeholder="Svi modeli" options={options.models} />
        <SelectFilter name="category" placeholder="Sve kategorije" options={lookups.categories.map((x) => ({ value: x.id, label: x.name }))} />
        <SelectFilter name="warehouse" placeholder="Sva skladišta" options={options.warehouses} />
        <ComboFilter name="supplier" placeholder="Svi dobavljači" partnerRole="supplier" current={supplierCur ? { value: supplierCur.id, label: supplierCur.name } : null} />
        <ComboFilter name="partner" placeholder="Svi klijenti" partnerRole="any" current={partnerCur ? { value: partnerCur.id, label: partnerCur.name } : null} />
        <SelectFilter name="year" placeholder="Godina uvoza" options={years.map((y) => ({ value: String(y), label: `${y}.` }))} />
        </div>
        {filtered && (
          <Link prefetch={false} href="/skladiste" className="text-sm text-fg-3 hover:text-fg">
            Očisti filtre
          </Link>
        )}
      </FilterBar>

      <SelectionProvider ids={list.rows.map((r) => r.id)}>
        {perms.canOps && <ItemBulkBar rows={rowMeta} options={options} perms={perms} />}
        {/* mobitel: kartice s velikim kvačicama; tablica ostaje za veće zaslone */}
        <ItemCards
          selectable={perms.canOps}
          rows={list.rows.map((r) => ({
            id: r.id,
            serial: r.serial,
            dupNote: r.dupNote,
            model: modelLabel(r.model),
            status: r.status,
            warehouse: r.warehouse?.name ?? null,
            partner: r.partner?.name ?? null,
          }))}
        />
        {list.rows.length > 0 && (
          <p className="mt-2 text-sm text-fg-3 sm:hidden">
            Ukupno filtrirano: {integer(list.total)} kom · {eur(list.costSum)}
          </p>
        )}
        <ScanFab />
        <TableWrap className={list.rows.length ? 'max-sm:hidden' : undefined}>
          {list.rows.length ? (
            <table className="data-table no-stack min-w-[1100px]">
              <thead>
                <tr>
                  <th className="w-8">{perms.canOps && <SelectAll />}</th>
                  <th>Serijski broj</th>
                  <th>Model</th>
                  <th>Kategorija</th>
                  <th>Status</th>
                  <th>Skladište</th>
                  <th>Klijent</th>
                  <th className="num">Nabavna</th>
                  <th>Uvoz</th>
                  <th>Izdano</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => (
                  <SelectableTr key={r.id} id={r.id}>
                    <td>{perms.canOps && <SelectRow id={r.id} />}</td>
                    <td className="whitespace-nowrap">
                      <Link prefetch={false} href={`/skladiste/${r.id}`} className="link font-mono text-sm">
                        {r.serial}
                      </Link>
                      {r.dupNote && <span className="ml-1.5 text-xs text-warn" title="Razlikovna napomena (dupli serijski)">({r.dupNote})</span>}
                    </td>
                    <td>{modelLabel(r.model)}</td>
                    <td className="text-fg-3">{r.model.category?.name ?? '—'}</td>
                    <td>
                      <Badge tone={COLOR_TONE[r.status.color] ?? 'neutral'}>{r.status.name}</Badge>
                    </td>
                    <td>{r.warehouse?.name ?? <span className="text-fg-4">—</span>}</td>
                    <td className="max-w-56 truncate">
                      {r.partner ? (
                        <Link prefetch={false} href={`/partneri/${r.partner.id}`} className="link">
                          {r.partner.name}
                        </Link>
                      ) : (
                        <span className="text-fg-4">—</span>
                      )}
                    </td>
                    <td className="num">{eur(num(r.cost))}</td>
                    <td className="whitespace-nowrap">{date(r.importDate)}</td>
                    <td className="whitespace-nowrap">{date(r.issueDate)}</td>
                  </SelectableTr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td colSpan={6}>Ukupno filtrirano: {integer(list.total)} kom</td>
                  <td className="num">{eur(list.costSum)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          ) : (
            <Empty
              icon={<Boxes className="size-5" />}
              title={filtered ? 'Nema uređaja za zadane filtre' : 'Skladište je prazno'}
              description={filtered ? 'Promijenite ili očistite filtre.' : 'Zaprimite prve uređaje.'}
            />
          )}
        </TableWrap>
      </SelectionProvider>
      <Pagination page={pg.page} pageSize={pg.pageSize} total={list.total} params={sp} basePath="/skladiste" />
    </>
  );
}

function chip(active: boolean) {
  return cn(
    'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm transition-colors',
    active ? 'bg-brand text-white' : 'bg-panel text-fg-2 shadow-[var(--shadow-panel)] hover:bg-muted',
  );
}
