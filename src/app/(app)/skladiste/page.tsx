import Link from 'next/link';
import { unstable_cache } from 'next/cache';
import type { ReactNode } from 'react';
import { PackagePlus, Boxes, ScanLine, ClipboardCheck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getLookups, modelLabel } from '@/server/queries/lookups';
import { itemFacets, listItems, parseItemFilters, type ItemListRow } from '@/server/queries/warehouse';
import { can, canSeeCost } from '@/domain/permissions';
import { num } from '@/domain/money';
import { toISO } from '@/domain/dates';
import { suggestedSalePrice } from '@/domain/pricing';
import { availableColumns, columnClass, warrantyDaysLeft, type ItemColumn } from '@/domain/warehouse-list';
import { PageHeader, Badge, COLOR_TONE, TableWrap, Empty } from '@/components/ui/misc';
import { FilterBar, MultiSelectFilter, SearchFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { SelectionProvider, SelectAll, SelectRow, SelectableTr } from '@/components/ui/selection';
import { SortHeader } from '@/components/ui/sort-header';
import { LinkButton } from '@/components/ui/button';
import { ComboFilter } from '@/components/warehouse/pickers';
import { ItemBulkBar, type RowMeta } from '@/components/warehouse/item-bulk-bar';
import { ItemCards, ScanFab } from '@/components/warehouse/item-cards';
import { ColumnChooser } from '@/components/warehouse/column-chooser';
import { STATE_LABEL, STATE_ORDER } from '@/domain/warehouse';
import { cn } from '@/lib/cn';
import { date, eur, integer } from '@/lib/format';
import { ExportButtons } from '@/components/ui/export-buttons';

type Params = Record<string, string | string[] | undefined>;

const FILTER_KEYS = ['q', 'status', 'state', 'model', 'category', 'warehouse', 'supplier', 'partner', 'year', 'cpu', 'screen', 'os'];
const SCOPE = 'wh-list';
/** Stupci koji se sortiraju (samo stupci uređaja s jeftinim sortiranjem — ITEM_SORTS). */
const SORTABLE: Partial<Record<ItemColumn, string>> = { import: 'uvoz', issue: 'izdano', cost: 'nabavna' };

function hrefWith(sp: Params, patch: Record<string, string | null>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v && k !== 'page') q.set(k, v);
  for (const [k, v] of Object.entries(patch)) (v ? q.set(k, v) : q.delete(k));
  const s = q.toString();
  return s ? `/skladiste?${s}` : '/skladiste';
}

/**
 * Vrijednosti filtara (godine, procesor, ekran, OS) traže prolaz kroz sve uređaje
 * firme — kod 300 000 uređaja se pamte 5 minuta umjesto upita pri svakom prikazu.
 */
const facetsCached = unstable_cache((companyId: string) => itemFacets(companyId), ['skladiste-facets'], { revalidate: 300 });

const dash = <span className="text-fg-4">—</span>;
const opts = (values: string[]) => values.map((v) => ({ value: v, label: v }));

export default async function WarehousePage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('warehouse', 'view');
  const sp = await searchParams;
  const f = parseItemFilters(sp);
  const pg = readPage(sp, 50);
  const c = user.companyId;

  const [list, lookups, facets, company, partnerCur, supplierCur] = await Promise.all([
    listItems(c, f, pg),
    getLookups(c),
    facetsCached(c),
    db.company.findUniqueOrThrow({ where: { id: c }, select: { statusChangeNeedsApproval: true, defaultMarginPct: true, defaultWarrantyMonths: true } }),
    f.partnerId ? db.partner.findFirst({ where: { id: f.partnerId, companyId: c }, select: { id: true, name: true } }) : null,
    f.supplierId ? db.partner.findFirst({ where: { id: f.supplierId, companyId: c }, select: { id: true, name: true } }) : null,
  ]);

  const costs = canSeeCost(user.perms);
  const perms = {
    canEdit: can(user.perms, 'warehouse', 'edit'),
    canOps: can(user.perms, 'warehouse', 'ops'),
    needsApproval: company.statusChangeNeedsApproval,
    canSeeCost: costs,
  };
  const options = {
    statuses: lookups.statuses.map((s) => ({ id: s.id, name: s.name, kind: s.kind, color: s.color })),
    warehouses: lookups.warehouses.map((w) => ({ value: w.id, label: w.name })),
    models: lookups.models.map((m) => ({ value: m.id, label: modelLabel(m) })),
  };
  const rowMeta: Record<string, RowMeta> = Object.fromEntries(
    list.rows.map((r) => [r.id, { state: r.state, onContract: !!r.contractItem, cost: costs ? num(r.cost) : 0 }]),
  );
  const exportQs = new URLSearchParams();
  for (const k of [...FILTER_KEYS, 'sort', 'dir']) if (typeof sp[k] === 'string' && sp[k]) exportQs.set(k, sp[k] as string);
  const filtered = FILTER_KEYS.some((k) => typeof sp[k] === 'string' && sp[k]);
  const allCount = Object.values(list.counts).reduce((a, b) => a + (b ?? 0), 0);
  const columns = availableColumns(costs);
  const companyMargin = num(company.defaultMarginPct);

  // ćelije po stupcu — svaki stupac nosi `data-col` za izbor vidljivih stupaca
  const cell = (r: ItemListRow): Record<ItemColumn, ReactNode> => {
    const cost = num(r.cost);
    const rent = r.rentPrice ?? r.model.rentPrice;
    const start = r.warrantyStart ?? r.invoice?.date ?? r.issueDate;
    const days = warrantyDaysLeft(start ? toISO(start) : null, r.warrantyMonths ?? r.model.warrantyMonths ?? company.defaultWarrantyMonths);
    const suggested = suggestedSalePrice({
      modelPrice: r.model.salePrice === null ? null : num(r.model.salePrice),
      cost,
      itemMargin: r.marginPct === null ? null : num(r.marginPct),
      modelMargin: r.model.marginPct === null ? null : num(r.model.marginPct),
      companyMargin,
    }).price;
    return {
      status: <Badge tone={COLOR_TONE[r.status.color] ?? 'neutral'}>{r.status.name}</Badge>,
      partner: r.partner ? (
        <Link prefetch={false} href={`/partneri/${r.partner.id}`} className="link">
          {r.partner.name}
        </Link>
      ) : (
        dash
      ),
      category: <span className="text-fg-3">{r.category?.name ?? r.model.category?.name ?? '—'}</span>,
      brand: <span className="text-fg-3">{r.model.brand ?? '—'}</span>,
      model: r.model.name,
      cpu: <span className="text-fg-3">{r.cpu ?? '—'}</span>,
      screen: <span className="text-fg-3">{r.screen ?? '—'}</span>,
      os: <span className="text-fg-3">{r.os ?? '—'}</span>,
      warehouse: r.warehouse?.name ?? dash,
      cost: eur(cost),
      suggested: <span className="text-fg-3">{eur(suggested)}</span>,
      sale: r.salePrice && num(r.salePrice) > 0 ? eur(num(r.salePrice)) : dash,
      rent: rent && num(rent) > 0 ? eur(num(rent)) : dash,
      import: date(r.importDate),
      issue: date(r.issueDate),
      invoice: r.invoice ? (
        <Link prefetch={false} href={`/prodaja/racuni/${r.invoice.id}`} className="link font-mono text-sm">
          {r.invoice.number ?? 'nacrt'}
        </Link>
      ) : (
        dash
      ),
      contract: r.contractItem ? (
        <Link prefetch={false} href={`/najam/ugovori/${r.contractItem.contractId}`} className="link font-mono text-sm">
          {r.contractItem.contract.number}
        </Link>
      ) : (
        dash
      ),
      warranty: days === null ? dash : days >= 0 ? <Badge tone="ok">{integer(days)} d</Badge> : <Badge>isteklo</Badge>,
    };
  };

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
            <ExportButtons href={`/api/skladiste/izvoz?${exportQs}`} />
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
        <MultiSelectFilter name="status" label="Status" options={options.statuses.map((s) => ({ value: s.id, label: s.name }))} />
        <MultiSelectFilter name="model" label="Model" options={options.models} searchable />
        <MultiSelectFilter name="category" label="Kategorija" options={lookups.categories.map((x) => ({ value: x.id, label: x.name }))} />
        <MultiSelectFilter name="warehouse" label="Skladište" options={options.warehouses} />
        <ComboFilter name="supplier" placeholder="Svi dobavljači" partnerRole="supplier" current={supplierCur ? { value: supplierCur.id, label: supplierCur.name } : null} />
        <ComboFilter name="partner" placeholder="Svi klijenti" partnerRole="any" current={partnerCur ? { value: partnerCur.id, label: partnerCur.name } : null} />
        {facets.cpu.length > 0 && <MultiSelectFilter name="cpu" label="Procesor" options={opts(facets.cpu)} />}
        {facets.screen.length > 0 && <MultiSelectFilter name="screen" label="Ekran" options={opts(facets.screen)} />}
        {facets.os.length > 0 && <MultiSelectFilter name="os" label="OS" options={opts(facets.os)} />}
        <MultiSelectFilter name="year" label="Godina uvoza" options={facets.years.map((y) => ({ value: String(y), label: `${y}.` }))} />
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
            Ukupno filtrirano: {integer(list.total)} kom{costs && ` · ${eur(list.costSum)}`}
          </p>
        )}
        <ScanFab />
        {list.rows.length > 0 && (
          <div className="mb-2 flex justify-end max-sm:hidden">
            <ColumnChooser columns={columns.map((x) => ({ key: x.key, label: x.label }))} canSeeCost={costs} scope={SCOPE} />
          </div>
        )}
        <TableWrap className={cn(SCOPE, list.rows.length ? 'max-sm:hidden' : undefined)}>
          {list.rows.length ? (
            <table className="data-table no-stack min-w-[1100px]">
              <thead>
                <tr>
                  <th className="w-8">{perms.canOps && <SelectAll />}</th>
                  <SortHeader label="Serijski broj" field="serijski" params={sp} basePath="/skladiste" />
                  {columns.map((col) =>
                    SORTABLE[col.key] ? (
                      <SortHeader
                        key={col.key}
                        label={col.label}
                        field={SORTABLE[col.key]!}
                        params={sp}
                        basePath="/skladiste"
                        defaultDir="desc"
                        align={col.num ? 'right' : undefined}
                        className={columnClass(col.key)}
                      />
                    ) : (
                      <th key={col.key} data-col={col.key} className={col.num ? 'num' : undefined}>
                        {col.label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => {
                  const cells = cell(r);
                  return (
                    <SelectableTr key={r.id} id={r.id}>
                      <td>{perms.canOps && <SelectRow id={r.id} />}</td>
                      <td className="whitespace-nowrap">
                        <Link prefetch={false} href={`/skladiste/${r.id}`} className="link font-mono text-sm">
                          {r.serial}
                        </Link>
                        {r.dupNote && <span className="ml-1.5 text-xs text-warn" title="Razlikovna napomena (dupli serijski)">({r.dupNote})</span>}
                      </td>
                      {columns.map((col) => (
                        <td
                          key={col.key}
                          data-col={col.key}
                          className={cn(col.num && 'num', (col.key === 'import' || col.key === 'issue') && 'whitespace-nowrap', col.key === 'partner' && 'max-w-56 truncate')}
                        >
                          {cells[col.key]}
                        </td>
                      ))}
                    </SelectableTr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td className="whitespace-nowrap">Ukupno filtrirano: {integer(list.total)} kom</td>
                  {columns.map((col) => (
                    <td key={col.key} data-col={col.key} className={col.num ? 'num' : undefined}>
                      {col.key === 'cost' ? eur(list.costSum) : null}
                    </td>
                  ))}
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
