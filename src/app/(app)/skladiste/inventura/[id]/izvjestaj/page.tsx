import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { getStocktake, stocktakeReport, type SnapRow } from '@/server/queries/stocktake';
import { STOCKTAKE_KIND_LABEL } from '@/domain/warehouse';
import { DocTable, DocumentShell, docDate } from '@/components/doc/document';
import { PageHeader } from '@/components/ui/misc';
import { PrintButton } from '@/components/ui/print-button';
import { dateTime, integer } from '@/lib/format';
import { PrintUnclip } from '@/components/warehouse/print-unclip';
import { ExportButtons } from '@/components/ui/export-buttons';

/** Ispis inventure: sažetak, nedostaje, višak i pronađeno (A4). */
export default async function StocktakeReportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('warehouse', 'view');
  const { id } = await params;
  const [st, company] = await Promise.all([getStocktake(user.companyId, id), getCompany(user.companyId)]);
  if (!st) notFound();
  const rep = await stocktakeReport(user.companyId, st);
  const c = rep.counts;
  const table = (rows: SnapRow[], extra = false) =>
    rows.length ? (
      <DocTable
        head={extra ? ['R.br.', 'Serijski broj', 'Model', 'Status / skladište', 'Razlog'] : ['R.br.', 'Serijski broj', 'Model', 'Status / skladište']}
        align={['right', 'left', 'left', 'left', 'left']}
        rows={rows.map((r, i) => [
          `${i + 1}.`,
          <span key="s" className="font-mono">
            {r.serial}
          </span>,
          r.model ?? '—',
          [r.status, r.warehouse].filter(Boolean).join(' · ') || '—',
          ...(extra ? [r.kind ? STOCKTAKE_KIND_LABEL[r.kind] : ''] : []),
        ])}
      />
    ) : (
      <p className="text-black/60">Nema.</p>
    );

  return (
    <>
      <PrintUnclip />
      <div className="no-print">
        <PageHeader
          back={
            <Link prefetch={false} href={`/skladiste/inventura/${st.id}`} className="hover:text-fg">
              ← Inventura {st.number}
            </Link>
          }
          title={`Izvještaj inventure ${st.number}`}
          subtitle={st.status === 'OPEN' ? 'Inventura je u tijeku — izvještaj prikazuje trenutno stanje.' : 'Stanje u trenutku zatvaranja.'}
          actions={
            <>
              <ExportButtons href={`/api/skladiste/inventura/${st.id}`} />
              <PrintButton />
            </>
          }
        />
      </div>
      {/* A4 list na uskom zaslonu klizi unutar sebe, stranica ostaje široka koliko zaslon */}
      <div className="overflow-x-auto scroll-slim print:overflow-visible">
        <DocumentShell
          company={company}
          title="Inventura"
          number={st.number}
          meta={[
            ['Skladište', st.warehouse?.name ?? 'Sva skladišta'],
            ['Započeta', dateTime(st.startedAt)],
            ['Zatvorena', st.closedAt ? dateTime(st.closedAt) : 'u tijeku'],
            ['Izradio', st.createdBy ?? '—'],
            ['Ispisano', docDate(new Date())],
          ]}
          signatures={['Popis obavio', 'Odobrio']}
        >
          <table className="mb-4 w-full border-collapse text-[12px]">
            <tbody>
              <tr className="border-y border-black/20">
                {(
                  [
                    ['Očekivano', c.expected],
                    ['Pronađeno', c.found],
                    ['Nedostaje', c.missing],
                    ['Višak', c.extra],
                    ['Skenirano', c.scanned],
                  ] as const
                ).map(([k, v]) => (
                  <td key={k} className="px-2 py-2 text-center">
                    <p className="text-[10px] uppercase tracking-wider text-black/50">{k}</p>
                    <p className="text-[16px] font-bold">{integer(v)}</p>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          {st.note && <p className="mb-3">Napomena: {st.note}</p>}
          {rep.actions && (rep.actions.moved > 0 || rep.actions.missingChanged > 0) && (
            <p className="mb-3">
              Pri zatvaranju:{' '}
              {[
                rep.actions.moved > 0 && `premješteno ${rep.actions.moved} uređaja (${rep.actions.transfers.join(', ')})`,
                rep.actions.missingChanged > 0 && `${rep.actions.missingChanged} nedostajućih → ${rep.actions.missingAction}`,
              ]
                .filter(Boolean)
                .join('; ')}
              .
            </p>
          )}
          <h3 className="mb-1 mt-4 text-[13px] font-bold">Nedostaje ({integer(rep.missing.length)})</h3>
          {table(rep.missing)}
          <h3 className="mb-1 mt-5 text-[13px] font-bold">Višak ({integer(rep.extra.length)})</h3>
          {table(rep.extra, true)}
          <h3 className="mb-1 mt-5 text-[13px] font-bold">Pronađeno ({integer(rep.found.length)})</h3>
          {table(rep.found)}
        </DocumentShell>
      </div>
    </>
  );
}
