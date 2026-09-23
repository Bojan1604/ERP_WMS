import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { dashboardData } from '@/server/queries/dashboard';
import { PageHeader, Card } from '@/components/ui/misc';
import { KpiTile, ActionPanel, PanelRow } from '@/components/dashboard/panels';
import { BarChart } from '@/components/charts/bar-chart';
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
    kpi.stock && <KpiTile key="stk" label="Vrijednost zalihe" value={eur(kpi.stock.value)} hint={`${integer(kpi.stock.count)} uređaja na skladištu`} href="/skladiste" />,
    kpi.rent && <KpiTile key="rent" label="Mjesečni najam" value={eur(kpi.rent.monthly)} hint={`${integer(kpi.rent.contracts)} aktivnih ugovora`} href="/najam/ugovori" />,
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
      <ActionPanel key="returning" title="U dolasku" count={d.returning} tone="info" href="/skladiste/izlaz" empty="Nema najavljenih povrata.">
        <p className="text-fg-2">Najavljeni povrati s terena — zaprimite ih kad stignu.</p>
      </ActionPanel>
    ),
    d.approvals !== null && (
      <ActionPanel key="approvals" title="Čeka odobrenje" count={d.approvals} tone="warn" href="/skladiste/odobrenja" empty="Nema zahtjeva na čekanju.">
        <p className="text-fg-2">Zahtjevi za promjenu statusa uređaja.</p>
      </ActionPanel>
    ),
    d.serviceOld && (
      <ActionPanel key="service" title="Servis otvoren dulje od 14 dana" count={d.serviceOld.count} tone="bad" href="/servis" empty="Nema zastarjelih servisnih naloga.">
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
              href={`/skladiste?model=${m.id}`}
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
    values: { sale: m.SALE, rent: m.RENT, service: m.SERVICE },
  }));
  const hasService = d.months?.some((m) => m.SERVICE !== 0);

  return (
    <>
      <PageHeader title="Nadzorna ploča" subtitle={`${user.companyName} · ${d.year}.`} />

      {tiles.length > 0 && <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">{tiles}</div>}

      <div className="grid gap-4 xl:grid-cols-3">
        {chartData && (
          <Card
            className="xl:col-span-2"
            title={`Prihod po mjesecima ${d.year}.`}
            actions={
              access.reports ? (
                <Link prefetch={false} href="/izvjestaji/prihod-po-mjesecima" className="text-sm text-brand hover:underline">
                  Izvještaj
                </Link>
              ) : null
            }
          >
            <BarChart
              data={chartData}
              series={[
                { key: 'sale', label: 'Prodaja' },
                { key: 'rent', label: 'Najam' },
                ...(hasService ? [{ key: 'service', label: 'Usluge' }] : []),
              ]}
              height={250}
              ariaLabel="Prihod po mjesecima, prodaja i najam"
              className="max-sm:hidden"
            />
            {/* mobitel: uži koordinatni sustav, da oznake osi ostanu čitljive */}
            <BarChart
              data={chartData}
              series={[
                { key: 'sale', label: 'Prodaja' },
                { key: 'rent', label: 'Najam' },
                ...(hasService ? [{ key: 'service', label: 'Usluge' }] : []),
              ]}
              height={280}
              width={440}
              ariaLabel="Prihod po mjesecima, prodaja i najam"
              className="sm:hidden"
            />
          </Card>
        )}
        {panels.length > 0 && (
          <div className={chartData ? 'grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-1' : 'grid content-start gap-3 sm:grid-cols-2 xl:col-span-3 xl:grid-cols-3'}>
            {panels.slice(0, chartData ? 2 : panels.length)}
          </div>
        )}
      </div>
      {chartData && panels.length > 2 && <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{panels.slice(2)}</div>}
      {!tiles.length && !panels.length && <p className="text-fg-3">Za vašu ulogu nema pokazatelja na nadzornoj ploči.</p>}
    </>
  );
}
