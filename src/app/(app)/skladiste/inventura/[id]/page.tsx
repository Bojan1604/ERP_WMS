import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileText, Trash2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { getLookups } from '@/server/queries/lookups';
import {
  extraKind, getStocktake, snapRow, stocktakeBreakdown, stocktakeLiveCounts, stocktakeRows, type SnapRow, type StocktakeSummary, type StocktakeTab,
} from '@/server/queries/stocktake';
import { db } from '@/server/db';
import { can } from '@/domain/permissions';
import { stocktakeCounts, STOCKTAKE_KIND_LABEL } from '@/domain/warehouse';
import { Badge, Empty, Notice, PageHeader } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { LinkButton } from '@/components/ui/button';
import { ActionButton } from '@/components/ui/action';
import { Pagination, readPage } from '@/components/ui/pagination';
import { StocktakeCounters, StocktakeSession } from '@/components/warehouse/stocktake-session';
import { CloseStocktakeButton } from '@/components/warehouse/stocktake-dialogs';
import { deleteStocktakeAction } from '../actions';
import { dateTime, integer } from '@/lib/format';
import { ExportButtons } from '@/components/ui/export-buttons';

type Params = Record<string, string | string[] | undefined>;

const TABS: Record<string, StocktakeTab> = { pronadeno: 'found', nedostaje: 'missing', visak: 'extra' };
const KIND_TONE = { found: 'ok', wrongWarehouse: 'warn', notInStock: 'warn', unknown: 'bad' } as const;

export default async function StocktakePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const user = await pageAccess('warehouse', 'view');
  const { id } = await params;
  const sp = await searchParams;
  const st = await getStocktake(user.companyId, id);
  if (!st) notFound();
  const tabKey = typeof sp.tab === 'string' && sp.tab in TABS ? sp.tab : 'nedostaje';
  const tab = TABS[tabKey];
  const pg = readPage(sp, 50);
  const open = st.status === 'OPEN';
  const canOps = can(user.perms, 'warehouse', 'ops');
  const canEdit = can(user.perms, 'warehouse', 'edit');

  let counts;
  let rows: SnapRow[];
  let total: number;
  let breakdown = { wrongWarehouse: 0 };
  const summary = st.summary as unknown as StocktakeSummary | null;
  if (open) {
    const [c, r, b] = await Promise.all([
      stocktakeLiveCounts(db, user.companyId, st),
      stocktakeRows(user.companyId, st, tab, pg),
      stocktakeBreakdown(user.companyId, st),
    ]);
    counts = c;
    rows = r.map((x) => snapRow(x, tab === 'extra' ? extraKind(x, st.warehouseId) : undefined));
    total = tab === 'found' ? c.found : tab === 'missing' ? c.missing : c.extra;
    breakdown = b;
  } else {
    counts = stocktakeCounts(summary?.expected ?? 0, summary?.scanned ?? 0, summary?.found ?? 0);
    const all = summary?.rows[tab] ?? [];
    total = all.length;
    rows = all.slice(pg.skip, pg.skip + pg.take);
  }
  const statuses = open && canEdit
    ? (await getLookups(user.companyId)).statuses.filter((s) => !['IN_STOCK', 'RENTED', 'WRITTEN_OFF'].includes(s.kind)).map((s) => ({ value: s.id, label: s.name }))
    : [];
  const base = `/skladiste/inventura/${st.id}`;

  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/skladiste/inventura" className="hover:text-fg">
            ← Inventure
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            Inventura {st.number}
            {open ? <Badge tone="warn">U tijeku</Badge> : <Badge tone="ok">Zatvorena</Badge>}
          </span>
        }
        subtitle={[st.warehouse?.name ?? 'Sva skladišta', `započeta ${dateTime(st.startedAt)}`, st.closedAt && `zatvorena ${dateTime(st.closedAt)}`, st.note]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            <LinkButton href={`${base}/izvjestaj`} icon={<FileText className="size-4" />}>
              Izvještaj
            </LinkButton>
            <ExportButtons href={`/api/skladiste/inventura/${st.id}`} />
            {open && canOps && (
              <CloseStocktakeButton
                id={st.id}
                number={st.number}
                hasWarehouse={!!st.warehouseId}
                counts={counts}
                wrongWarehouse={breakdown.wrongWarehouse}
                statuses={statuses}
                canEdit={canEdit}
              />
            )}
            {open && canEdit && (
              <ActionButton
                variant="ghost"
                className="text-bad-strong"
                icon={<Trash2 className="size-4" />}
                action={deleteStocktakeAction}
                input={{ id: st.id }}
                confirm={`Obrisati inventuru ${st.number} sa svim skenovima? Uređaji se ne mijenjaju.`}
                confirmLabel="Obriši"
              >
                Obriši
              </ActionButton>
            )}
          </>
        }
      />

      {open && canOps ? (
        <div className="mb-4 lg:max-w-xl">
          <StocktakeSession id={st.id} initialCounts={counts} />
        </div>
      ) : (
        <StocktakeCounters counts={counts} className="mb-4 lg:max-w-xl" />
      )}
      {!open && summary && (summary.actions.moved > 0 || summary.actions.missingChanged > 0) && (
        <Notice tone="info">
          Pri zatvaranju:{' '}
          {[
            summary.actions.moved > 0 && `premješteno ${integer(summary.actions.moved)} uređaja (${summary.actions.transfers.join(', ')})`,
            summary.actions.missingChanged > 0 && `${integer(summary.actions.missingChanged)} nedostajućih → ${summary.actions.missingAction}`,
          ]
            .filter(Boolean)
            .join('; ')}
          .
        </Notice>
      )}

      <Tabs
        param="tab"
        tabs={[
          { href: base, label: 'Nedostaje', count: counts.missing },
          { href: `${base}?tab=pronadeno`, label: 'Pronađeno', count: counts.found },
          { href: `${base}?tab=visak`, label: 'Višak', count: counts.extra },
        ]}
      />
      {rows.length ? (
        <ul className="divide-y divide-line rounded-lg bg-panel shadow-[var(--shadow-panel)]" data-rows={tab}>
          {rows.map((r, i) => (
            <li key={`${r.serial}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-base">
                  {r.itemId ? (
                    <Link prefetch={false} href={`/skladiste/${r.itemId}`} className="link">
                      {r.serial}
                    </Link>
                  ) : (
                    r.serial
                  )}
                </p>
                <p className="truncate text-sm text-fg-3">{[r.model, r.status, r.warehouse].filter(Boolean).join(' · ') || 'Nema u bazi'}</p>
              </div>
              {r.kind && r.kind !== 'found' && <Badge tone={KIND_TONE[r.kind]}>{STOCKTAKE_KIND_LABEL[r.kind]}</Badge>}
              {r.at && (
                <span className="w-full text-xs text-fg-4 sm:w-auto">
                  {dateTime(r.at)}
                  {r.by ? ` · ${r.by}` : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-lg bg-panel shadow-[var(--shadow-panel)]">
          <Empty
            title={tab === 'missing' ? 'Ništa ne nedostaje' : tab === 'found' ? 'Još ništa nije pronađeno' : 'Nema viška'}
            description={tab === 'missing' ? 'Svi očekivani uređaji su skenirani.' : undefined}
          />
        </div>
      )}
      <Pagination page={pg.page} pageSize={pg.pageSize} total={total} params={sp} basePath={base} />
    </>
  );
}
