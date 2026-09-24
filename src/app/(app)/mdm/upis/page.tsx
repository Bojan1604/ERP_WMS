import Link from 'next/link';
import { headers } from 'next/headers';
import { KeyRound, Trash2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { env } from '@/server/env';
import { getMdmScope } from '@/server/mdm/scope';
import { tokenState } from '@/server/mdm/enroll';
import { androidSignatureChecksum } from '@/server/mdm/agent';
import { enrollTokens, orgOptions, pendingDevices, profileOptions, siteOptions } from '@/server/queries/mdm';
import { PLATFORM_LABEL, type Platform } from '@/domain/mdm';
import { Badge, Card, Empty, PageHeader } from '@/components/ui/misc';
import { ActionButton } from '@/components/ui/action';
import { LinkButton } from '@/components/ui/button';
import { CreateTokenDialog, EnrollDialog } from '@/components/mdm/enroll-forms';
import { EnrollTokenPanel } from '@/components/mdm/enroll-token-panel';
import { Ago, PlatformIcon } from '@/components/mdm/common';
import { AutoRefresh } from '@/components/mdm/commands-refresh';
import { date, integer } from '@/lib/format';
import { revokeTokenAction } from './actions';

export const metadata = { title: 'Upis uređaja' };

type Params = Record<string, string | string[] | undefined>;

/** Javna adresa poslužitelja za agente: APP_URL, inače adresa iz zahtjeva. */
async function appUrl() {
  const fromEnv = env().APP_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

const STATE: Record<string, { label: string; tone: 'ok' | 'neutral' | 'warn' }> = {
  active: { label: 'aktivan', tone: 'ok' },
  used: { label: 'iskorišten', tone: 'neutral' },
  expired: { label: 'istekao', tone: 'warn' },
};

export default async function EnrollPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('mdm', 'edit');
  const scope = await getMdmScope(user);
  const sp = await searchParams;
  const [orgs, sites, profiles, tokens, pending, url] = await Promise.all([
    orgOptions(scope, { activeOnly: true }),
    siteOptions(scope),
    profileOptions(scope),
    enrollTokens(scope),
    pendingDevices(scope),
    appUrl(),
  ]);
  const code = typeof sp.kod === 'string' && /^\d{6}$/.test(sp.kod) ? sp.kod : null;
  const selected = typeof sp.kljuc === 'string' ? tokens.find((t) => t.id === sp.kljuc) ?? null : null;
  const opts = {
    orgs: orgs.map((o) => ({ id: o.id, label: o.label })),
    sites,
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, platform: p.platform as Platform })),
  };
  const checksum = await androidSignatureChecksum();
  const host = new URL(url).host;

  return (
    <>
      <AutoRefresh active={scope.owner} seconds={15} />
      <PageHeader title="Upis uređaja" subtitle="Kod sa zaslona uređaja ili ključ za automatski upis" actions={<EnrollDialog {...opts} initialCode={code} />} />

      {!orgs.length && (
        <Card className="mb-4">
          <Empty title="Nema organizacija" description="Uređaj se upisuje u organizaciju (klijenta). Prvo otvorite organizaciju." action={<LinkButton href="/mdm/organizacije" variant="primary">Organizacije</LinkButton>} />
        </Card>
      )}

      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title="Kako upisati uređaj">
          <ol className="list-decimal space-y-1.5 pl-5 text-base text-fg-2">
            <li>Instalirajte agenta na uređaj (Android: QR ili APK; Windows: PowerShell naredba — vidi ključeve za upis ispod).</li>
            <li>Agent se javlja poslužitelju i na zaslonu prikazuje <b>šesteroznamenkasti kod</b>.</li>
            <li>Kliknite <b>Upiši uređaj kodom</b>, upišite kod i odaberite organizaciju i lokaciju.</li>
            <li>Uređaj preuzima konfiguraciju lokacije i na zaslonu prikazuje naziv organizacije.</li>
          </ol>
          <p className="mt-3 text-sm text-fg-3">S ključem za upis (QR / PowerShell s <code className="font-mono">-Token</code>) uređaj se upisuje sam, bez koda.</p>
        </Card>
        <Card title="Mrežni zahtjevi">
          <p className="text-sm text-fg-2">Uređaj mora moći otvoriti odlaznu vezu prema poslužitelju:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg-2">
            <li>
              <b className="font-mono">{host}</b> — TCP <b>443</b> (HTTPS)
            </li>
            <li>Dolazni portovi na uređaju nisu potrebni — agent se sam javlja svakih 60 s i preuzima naredbe.</li>
            <li>Snimke zaslona i zapisnici šalju se istom HTTPS vezom (bez dodatnih portova).</li>
            <li>Android QR upis: pristup internetu za preuzimanje APK-a agenta.</li>
          </ul>
        </Card>
      </div>

      {scope.owner && (
        <Card title={`Uređaji koji čekaju upis (${integer(pending.length)})`} className="mb-4" padded={!pending.length}>
          {pending.length ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Uređaj</th>
                  <th>Kod</th>
                  <th>Model</th>
                  <th>Serijski</th>
                  <th>IP</th>
                  <th>Javio se</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        <PlatformIcon platform={d.platform} />
                        <Link prefetch={false} href={`/mdm/uredaji/${d.id}`} className="link font-medium">
                          {d.name}
                        </Link>
                      </span>
                    </td>
                    <td className="font-mono text-md tracking-widest">{d.enrollCode ?? '—'}</td>
                    <td>{[d.manufacturer, d.model].filter(Boolean).join(' ') || PLATFORM_LABEL[d.platform as Platform]}</td>
                    <td className="font-mono text-sm">{d.serial ?? '—'}</td>
                    <td className="font-mono text-sm">{d.ipAddress ?? '—'}</td>
                    <td>
                      <Ago at={d.lastSeenAt ?? d.createdAt} />
                    </td>
                    <td className="text-right">{d.enrollCode && <LinkButton href={`/mdm/upis?kod=${d.enrollCode}`} size="sm" variant="subtle">Upiši</LinkButton>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-fg-3">Nema uređaja na čekanju. Kad se agent javi, uređaj se ovdje pojavljuje s kodom.</p>
          )}
        </Card>
      )}

      <Card title="Ključevi za automatski upis" actions={orgs.length > 0 && <CreateTokenDialog {...opts} />} padded={!tokens.length} className="mb-4">
        {tokens.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Oznaka</th>
                <th>Organizacija › lokacija</th>
                <th className="num">Upisa</th>
                <th>Vrijedi do</th>
                <th>Stanje</th>
                <th>Izradio</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const st = STATE[tokenState(t)];
                return (
                  <tr key={t.id} data-selected={selected?.id === t.id}>
                    <td>
                      <Link prefetch={false} href={`/mdm/upis?kljuc=${t.id}`} scroll={false} className="link font-medium">
                        {t.label ?? `Ključ ${t.token.slice(0, 6)}…`}
                      </Link>
                    </td>
                    <td>
                      {t.org.name}
                      {t.site && <span className="text-fg-3"> › {t.site.name}</span>}
                    </td>
                    <td className="num">
                      {integer(t.uses)}
                      {t.maxUses !== null && <span className="text-fg-3"> / {integer(t.maxUses)}</span>}
                    </td>
                    <td>{t.expiresAt ? date(t.expiresAt) : <span className="text-fg-4">bez isteka</span>}</td>
                    <td>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                    <td className="text-fg-2">{t.createdBy ?? '—'}</td>
                    <td className="whitespace-nowrap text-right">
                      <LinkButton href={`/mdm/upis?kljuc=${t.id}`} size="sm" variant="ghost">
                        QR / upute
                      </LinkButton>
                      <ActionButton action={revokeTokenAction} input={{ id: t.id }} size="sm" variant="ghost" icon={<Trash2 className="size-4" />} confirm="Opozvati ključ? Uređaji koji su već upisani ostaju upisani.">
                        Opozovi
                      </ActionButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty icon={<KeyRound className="size-5" />} title="Nema ključeva" description="Ključ omogućuje upis bez koda: QR za Android (Device Owner) ili PowerShell naredba za Windows." />
        )}
      </Card>

      {selected && tokenState(selected) === 'active' ? (
        <EnrollTokenPanel appUrl={url} token={selected.token} title={selected.label ?? `${selected.org.name}${selected.site ? ` › ${selected.site.name}` : ''}`} checksum={checksum} />
      ) : selected ? (
        <Card>
          <p className="text-sm text-fg-3">Ključ više nije aktivan (istekao ili iskorišten) — izradite novi.</p>
        </Card>
      ) : (
        tokens.length > 0 && <p className="text-sm text-fg-3">Odaberite ključ za prikaz QR koda i Windows naredbe.</p>
      )}
    </>
  );
}
