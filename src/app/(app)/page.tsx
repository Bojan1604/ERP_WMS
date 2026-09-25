import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { dashboardData } from '@/server/queries/dashboard';
import { PageHeader, Card } from '@/components/ui/misc';
import { KpiTile, ActionPanel, NoticeBar, PanelRow } from '@/components/dashboard/panels';
import { DonutChart, RevenueProfitChart } from '@/components/dashboard/charts';
import { eur, integer, date, pct } from '@/lib/format';
import { MONTHS_HR, MONTHS_SHORT, daysBetween, toISO } from '@/domain/dates';
import { grossMargin } from '@/domain/pricing';
import { modelLabel } from '@/server/queries/lookups';

export const metadata = { title: 'Nadzorna ploča' };

export default async function Dashboard() {
  const user = await pageAccess('dashboard');
  const d = await dashboardData(user.companyId, user.perms);
  const { kpi, access } = d;
  // poveznice na izvještaje samo uz pravo na izvještaje
  const rep = (slug: string, fallback?: string) => (access.reports ? `/izvjestaji/${slug}` : fallback);
  const margin = kpi.revenue !== null && kpi.grossProfit !== null ? grossMargin(kpi.revenue, kpi.revenue - kpi.grossProfit) : null;

  const tiles = [
    kpi.revenue !== null && (
      <KpiTile key="rev" label={`Prihod ${d.year}. (neto)`} value={eur(kpi.revenue)} hint="Računi, storna i odobrenja" href={rep('prihod-po-mjesecima')} />
    ),
    kpi.grossProfit !== null && (
      <KpiTile
        key="gp"
        label="Bruto dobit"
        value={eur(kpi.grossProfit)}
        hint={`Prihod − nabavna vrijednost prodanog${margin !== null ? ` · marža ${pct(margin)}` : ''}`}
        href={rep('profit-po-mjesecima')}
      />
    ),
    kpi.receivables && (
      <KpiTile key="rec" label="Otvorena potraživanja" value={eur(kpi.receivables.amount)} hint={`${integer(kpi.receivables.count)} računa`} href={rep('nenaplaceni-racuni', '/prodaja/racuni')} />
    ),
    kpi.overdue && (
      <KpiTile
        key="ovd"
        label="Dospjelo, nenaplaćeno"
        value={eur(kpi.overdue.amount)}
        hint={`${integer(kpi.overdue.count)} računa kasni`}
        tone={kpi.overdue.amount > 0 ? 'bad' : undefined}
        href={rep('starost-potrazivanja', '/prodaja/racuni')}
      />
    ),
    kpi.stock &&
      (kpi.stock.value !== null ? (
        <KpiTile key="stk" label="Vrijednost zalihe" value={eur(kpi.stock.value)} hint={`${integer(kpi.stock.count)} uređaja na skladištu`} href="/skladiste" />
      ) : (
        <KpiTile key="stk" label="Na skladištu" value={integer(kpi.stock.count)} hint="uređaja" href="/skladiste" />
      )),
    kpi.rent && <KpiTile key="rent" label="Mjesečni najam" value={eur(kpi.rent.monthly)} hint={`${integer(kpi.rent.contracts)} aktivnih ugovora`} href="/najam/ugovori" />,
    kpi.expenses && (
      <KpiTile
        key="exp"
        label={`Troškovi ${d.year}.`}
        value={eur(kpi.expenses.amount)}
        hint={kpi.expenses.net !== null ? `Neto rezultat ${eur(kpi.expenses.net)}` : 'Neto, bez PDV-a'}
        tone={kpi.expenses.net !== null && kpi.expenses.net < 0 ? 'bad' : undefined}
        href={rep('neto-rezultat', '/troskovi')}
      />
    ),
    kpi.serviceOpen !== null && (
      <KpiTile key="svc" label="U servisu" value={integer(kpi.serviceOpen)} hint="Otvorenih servisnih naloga" href="/servis" tone={kpi.serviceOpen > 0 ? undefined : 'ok'} />
    ),
  ].filter(Boolean);

  const notices = [
    d.portal && d.portal.count > 0 && (
      <NoticeBar
        key="portal"
        tone="bad"
        tag="Portal"
        title={d.portal.count === 1 ? 'Nova prijava kvara s portala' : `${d.portal.count} nove prijave kvara s portala`}
        detail={`${d.portal.rows.map((r) => [r.partner, r.serial].filter(Boolean).join(' · ')).join(', ')}${d.portal.count > 3 ? '…' : ''}`}
        href="/servis?status=REPORTED"
        linkLabel="Servis"
      />
    ),
    d.returns && d.returns.count > 0 && (
      <NoticeBar
        key="returns"
        tone="info"
        tag="Povrat"
        title={`${integer(d.returns.count)} uređaja treba vratiti s terena`}
        detail={`${d.returns.reasons} · ugovor ${d.returns.contracts.slice(0, 3).join(', ')}${d.returns.contracts.length > 3 ? '…' : ''}`}
        href="/skladiste/izlaz?tab=povrat"
        linkLabel="Povrat opreme"
      />
    ),
    d.receive && d.receive.count > 0 && (
      <NoticeBar
        key="receive"
        tone="warn"
        tag={String(d.receive.count)}
        title="Zaprimanje robe čeka vašu potvrdu"
        detail={`${d.receive.by.join(', ')} · ${integer(d.receive.codes)} kodova`}
        href="/skladiste/odobrenja"
        linkLabel="Provjeri"
      />
    ),
    d.backupDue && (
      <NoticeBar
        key="backup"
        tone="warn"
        tag="Kopija"
        title={d.backupDue.last ? `Zadnja sigurnosna kopija prije ${d.backupDue.days} dana` : 'Sigurnosna kopija još nije napravljena'}
        detail="Postavke → Podaci → Napravi kopiju, pa je preuzmite i spremite izvan poslužitelja"
        href="/postavke/podaci"
        linkLabel="Kopije"
      />
    ),
  ].filter(Boolean);

  const panels = [
    d.pending && (
      <ActionPanel key="pending" title="Rate najma za izdati" count={d.pending.count} tone="brand" href="/najam/rate" linkLabel="Izdaj rate" empty="Sve dospjele rate su fakturirane.">
        <p className="text-fg-2">
          Ukupno <b className="tnum text-fg">{eur(d.pending.amount)}</b> dospjelih, a nefakturiranih rata.
        </p>
      </ActionPanel>
    ),
    d.overdueTop && kpi.overdue && (
      <ActionPanel key="overdue" title="Računi koji kasne" count={kpi.overdue.count} tone="bad" href={rep('nenaplaceni-racuni', '/prodaja/racuni')} linkLabel="Svi nenaplaćeni" empty="Nijedan račun ne kasni.">
        <ul>
          {d.overdueTop.map((i) => (
            <PanelRow
              key={i.id}
              href={`/prodaja/racuni/${i.id}`}
              left={i.partner}
              sub={`${i.number ?? '—'} · kasni ${i.dueDate ? daysBetween(toISO(i.dueDate), d.today) : 0} d`}
              right={eur(i.open)}
            />
          ))}
        </ul>
      </ActionPanel>
    ),
    d.reserved !== null && (
      <ActionPanel key="reserved" title="Izašlo iz skladišta" count={d.reserved} tone="warn" href="/skladiste/izlaz" empty="Nema uređaja koji čekaju račun ili ugovor.">
        <p className="text-fg-2">Uređaji su izašli sa skladišta i čekaju račun ili ugovor.</p>
      </ActionPanel>
    ),
    d.returning !== null && (
      <ActionPanel key="returning" title="U dolasku" count={d.returning} tone="info" href="/skladiste/izlaz?tab=dolazak" empty="Nema najavljenih povrata.">
        <p className="text-fg-2">Najavljeni povrati s terena — zaprimite ih kad stignu.</p>
      </ActionPanel>
    ),
    d.approvals !== null && (
      <ActionPanel key="approvals" title="Čeka odobrenje" count={d.approvals} tone="warn" href="/skladiste/odobrenja" empty="Nema zahtjeva na čekanju.">
        <p className="text-fg-2">Zahtjevi za promjenu statusa uređaja.</p>
      </ActionPanel>
    ),
    d.serviceOld && (
      <ActionPanel key="service" title="Servis otvoren dulje od 14 dana" count={d.serviceOld.count} tone="bad" href="/servis?long=1" empty="Nema zastarjelih servisnih naloga.">
        <ul>
          {d.serviceOld.rows.map((s) => (
            <PanelRow
              key={s.id}
              href={`/servis/${s.id}`}
              left={s.number}
              sub={[s.serial, s.partner?.name].filter(Boolean).join(' · ')}
              right={`${daysBetween(toISO(s.reportedAt), d.today)} d`}
            />
          ))}
        </ul>
      </ActionPanel>
    ),
    d.lowStock && (
      <ActionPanel key="low" title="Niska zaliha" count={d.lowStock.length} tone="warn" empty="Svi modeli su iznad minimalne zalihe.">
        <ul>
          {d.lowStock.slice(0, 6).map((m) => (
            <PanelRow
              key={m.id}
              href={`/skladiste?model=${m.id}&state=IN_STOCK`}
              left={modelLabel(m)}
              right={
                <span>
                  <b className="text-bad-strong">{m.stock}</b> / {m.minStock}
                </span>
              }
            />
          ))}
        </ul>
      </ActionPanel>
    ),
    d.stale && (
      <ActionPanel key="stale" title="Zaliha starija od godine dana" count={d.stale.count} tone="warn" href={rep('starost-zalihe', '/skladiste?state=IN_STOCK')} linkLabel="Starost zalihe" empty="Zaliha je svježa.">
        {d.stale.value !== null && (
          <p className="pb-1 text-fg-2">
            Vezano <b className="tnum text-fg">{eur(d.stale.value)}</b> nabavne vrijednosti.
          </p>
        )}
        <ul>
          {d.stale.rows.map((r) => (
            <PanelRow key={r.id} href={`/skladiste/${r.id}`} left={r.serial} sub={`${r.model} · od ${date(r.since)}`} right={`${Math.round(daysBetween(r.since, d.today) / 30)} mj`} />
          ))}
        </ul>
      </ActionPanel>
    ),
    d.warranties && (
      <ActionPanel
        key="warranty"
        title="Jamstvo istječe u 30 dana"
        count={d.warranties.length}
        tone="info"
        href={rep('garancije-istjecu')}
        linkLabel="Izvještaj o jamstvima"
        empty="Nijedno jamstvo ne istječe uskoro."
      >
        <ul>
          {d.warranties.slice(0, 5).map((w) => (
            <PanelRow key={w.id} href={`/skladiste/${w.id}`} left={w.serial} sub={[w.model, w.partner].filter(Boolean).join(' · ')} right={date(w.ends)} />
          ))}
        </ul>
      </ActionPanel>
    ),
  ].filter(Boolean);

  const chartData = d.months?.map((m, i) => ({
    label: MONTHS_SHORT[i],
    title: `${MONTHS_HR[i]} ${d.year}.`,
    revenue: m.SALE + m.RENT + m.SERVICE,
    profit: m.profit,
  }));

  return (
    <>
      <PageHeader title="Nadzorna ploča" subtitle={`${user.companyName} · ${d.year}.`} />

      {notices.length > 0 && <div className="mb-4 grid gap-2">{notices}</div>}

      {tiles.length > 0 && <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">{tiles}</div>}

      <div className="grid gap-4 xl:grid-cols-3">
        {chartData && (
          <Card
            className="xl:col-span-2"
            title={`Prihod${access.costs ? ' i dobit' : ''} po mjesecima ${d.year}.`}
            actions={
              access.reports ? (
                <Link prefetch={false} href="/izvjestaji/prihod-po-mjesecima" className="text-sm text-brand hover:underline">
                  Izvještaj
                </Link>
              ) : null
            }
          >
            <RevenueProfitChart data={chartData} height={240} className="max-sm:hidden" />
            {/* mobitel: uži koordinatni sustav, da oznake osi ostanu čitljive */}
            <RevenueProfitChart data={chartData} height={280} width={440} className="sm:hidden" />
          </Card>
        )}
        {panels.length > 0 && (
          <div className={chartData ? 'grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-1' : 'grid content-start gap-3 sm:grid-cols-2 xl:col-span-3 xl:grid-cols-3'}>
            {panels.slice(0, chartData ? 2 : panels.length)}
          </div>
        )}
      </div>
      {chartData && panels.length > 2 && <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{panels.slice(2)}</div>}
      {d.byStatus && d.byStatus.length > 0 && (
        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <Card title="Uređaji po statusu">
            <DonutChart data={d.byStatus.map((x) => ({ label: x.name, value: x.cnt, href: `/skladiste?status=${x.id}` }))} />
          </Card>
        </div>
      )}
      {!tiles.length && !panels.length && !notices.length && <p className="text-fg-3">Za vašu ulogu nema pokazatelja na nadzornoj ploči.</p>}
    </>
  );
}
