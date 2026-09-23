import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Search } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { globalSearch } from '@/server/queries/search';
import { Badge, COLOR_TONE, Empty, PageHeader } from '@/components/ui/misc';
import { SearchFilter } from '@/components/ui/filters';
import { CONTRACT_STATUS_LABEL } from '@/domain/billing';
import { INVOICE_KIND_LABEL } from '@/domain/invoice';
import { num } from '@/domain/money';
import { date, eur } from '@/lib/format';

export const metadata = { title: 'Pretraga' };

const QUOTE_STATUS = { DRAFT: 'Nacrt', SENT: 'Poslana', ACCEPTED: 'Prihvaćena', REJECTED: 'Odbijena' } as const;
const SERVICE_STATUS = {
  REPORTED: 'Prijavljeno', RECEIVED: 'Zaprimljeno', DIAGNOSIS: 'Dijagnostika', AT_SUPPLIER: 'Kod dobavljača',
  REPAIRED: 'Popravljeno', REPLACED: 'Zamijenjeno', WRITTEN_OFF: 'Otpisano',
} as const;

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="rounded-lg bg-panel shadow-[var(--shadow-panel)]">
      <h2 className="flex items-center justify-between border-b border-line px-4 py-2.5 text-base font-semibold">
        {title}
        <span className="text-sm font-normal text-fg-3">{count === 10 ? '10+' : count}</span>
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

function Hit({ href, title, sub, right }: { href: string; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <li className="border-b border-line/70 last:border-0">
      <Link prefetch={false} href={href} className="flex items-center gap-3 px-4 py-2 hover:bg-panel-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{title}</span>
          {sub && <span className="block truncate text-sm text-fg-3">{sub}</span>}
        </span>
        {right && <span className="shrink-0 text-right text-sm">{right}</span>}
      </Link>
    </li>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await pageAccess('dashboard');
  const q = ((await searchParams).q ?? '').trim();
  const r = q ? await globalSearch(user.companyId, user.perms, q) : null;
  if (r?.exactDeviceId) redirect(`/skladiste/${r.exactDeviceId}`);

  const groups = r
    ? [
        r.devices?.length ? (
          <Group key="d" title="Uređaji" count={r.devices.length}>
            {r.devices.map((d) => (
              <Hit
                key={d.id}
                href={`/skladiste/${d.id}`}
                title={<span className="font-mono">{d.serial}{d.dupNote && <span className="ml-2 font-sans text-xs text-fg-3">({d.dupNote})</span>}</span>}
                sub={[[d.model.brand, d.model.name].filter(Boolean).join(' '), d.partner?.name].filter(Boolean).join(' · ')}
                right={<Badge tone={COLOR_TONE[d.status.color] ?? 'neutral'}>{d.status.name}</Badge>}
              />
            ))}
          </Group>
        ) : null,
        r.invoices?.length ? (
          <Group key="i" title="Računi" count={r.invoices.length}>
            {r.invoices.map((i) => (
              <Hit
                key={i.id}
                href={`/prodaja/racuni/${i.id}`}
                title={`${i.kind === 'INVOICE' ? 'Račun' : INVOICE_KIND_LABEL[i.kind]} ${i.number}`}
                sub={`${i.partner.name} · ${date(i.date)}`}
                right={
                  <>
                    <span className="block tnum">{eur(num(i.grandTotal))}</span>
                    {num(i.openAmount) > 0 && <span className="block text-xs text-bad-strong tnum">otvoreno {eur(num(i.openAmount))}</span>}
                  </>
                }
              />
            ))}
          </Group>
        ) : null,
        r.partners?.length ? (
          <Group key="p" title="Partneri" count={r.partners.length}>
            {r.partners.map((p) => (
              <Hit key={p.id} href={`/partneri/${p.id}`} title={p.name} sub={[p.oib && `OIB ${p.oib}`, p.city].filter(Boolean).join(' · ')} right={p.excluded ? <Badge>isključen</Badge> : null} />
            ))}
          </Group>
        ) : null,
        r.contracts?.length ? (
          <Group key="c" title="Ugovori" count={r.contracts.length}>
            {r.contracts.map((c) => (
              <Hit key={c.id} href={`/najam/ugovori/${c.id}`} title={c.number} sub={`${c.partner.name} · od ${date(c.startDate)}`} right={<Badge tone={c.status === 'ACTIVE' ? 'ok' : 'neutral'}>{CONTRACT_STATUS_LABEL[c.status]}</Badge>} />
            ))}
          </Group>
        ) : null,
        r.quotes?.length ? (
          <Group key="q" title="Ponude" count={r.quotes.length}>
            {r.quotes.map((x) => (
              <Hit key={x.id} href={`/prodaja/ponude/${x.id}`} title={x.number} sub={`${x.partner.name} · ${date(x.date)}`} right={<><span className="block tnum">{eur(num(x.grandTotal))}</span><span className="block text-xs text-fg-3">{QUOTE_STATUS[x.status]}</span></>} />
            ))}
          </Group>
        ) : null,
        r.services?.length ? (
          <Group key="s" title="Servisni nalozi" count={r.services.length}>
            {r.services.map((s) => (
              <Hit key={s.id} href={`/servis/${s.id}`} title={s.number} sub={[s.serial, s.partner?.name, s.issue].filter(Boolean).join(' · ')} right={<span className="text-fg-3">{SERVICE_STATUS[s.status]}</span>} />
            ))}
          </Group>
        ) : null,
      ].filter(Boolean)
    : [];

  return (
    <>
      <PageHeader title="Pretraga" subtitle={q ? `Rezultati za „${q}"` : 'Serijski broj, broj računa, ugovora, ponude ili servisa, naziv ili OIB partnera'} />
      <div className="mb-4">
        <SearchFilter placeholder="Traži…" className="sm:w-96" />
      </div>
      {!q ? (
        <Empty icon={<Search className="size-5" />} title="Upišite pojam za pretragu" />
      ) : groups.length ? (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">{groups}</div>
      ) : (
        <Empty icon={<Search className="size-5" />} title="Nema rezultata" description="Provjerite upisani pojam ili pokušajte s dijelom serijskog broja." />
      )}
    </>
  );
}
