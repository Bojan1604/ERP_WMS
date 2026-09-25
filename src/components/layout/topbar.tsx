'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Building2, ChevronDown, LogOut, Moon, RefreshCw, Search, Sun, UserRound, Users } from 'lucide-react';
import { logout } from '@/app/(auth)/login/actions';
import { switchCompanyAction } from '@/app/(app)/postavke/firme/actions';
import { cn } from '@/lib/cn';

interface Online { id: string; name: string; lastSeenAt: string }

/** Provjera nove verzije i tko je prijavljen — svake 3 minute (i pri povratku na karticu). */
const POLL_MS = 3 * 60_000;

function useStatus(initialBuild: string, initialOnline: Online[]) {
  const build = useRef(initialBuild);
  const [online, setOnline] = useState(initialOnline);
  const [newVersion, setNewVersion] = useState(false);
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await fetch('/api/status', { cache: 'no-store' });
        if (!r.ok || stop) return;
        const s = (await r.json()) as { buildId: string; online: Online[] };
        setOnline(s.online);
        if (build.current !== 'dev' && s.buildId !== 'dev' && s.buildId !== build.current) setNewVersion(true);
      } catch {
        /* mreža nedostupna — pokušava se sljedeći put */
      }
    };
    const t = setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      stop = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', poll);
    };
  }, []);
  return { online, newVersion };
}

function Menu({ label, icon, children, title }: { label: React.ReactNode; icon: React.ReactNode; children: (close: () => void) => React.ReactNode; title?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen(!open)} title={title} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-fg-2 hover:bg-muted">
        {icon}
        {label}
        <ChevronDown className="size-3.5 text-fg-4" />
      </button>
      {open && <div className="absolute right-0 z-50 mt-1 min-w-56 rounded-lg border border-line bg-panel p-1 shadow-[var(--shadow-pop)]">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Topbar({
  user,
  companies = [],
  companyId,
  online: initialOnline = [],
  buildId = 'dev',
}: {
  user: { id?: string; name: string; role: string };
  /** Firme kojima korisnik ima pristup (prebacivanje se prikazuje kad ih je više). */
  companies?: Array<{ id: string; name: string }>;
  companyId?: string;
  online?: Online[];
  buildId?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [dark, setDark] = useState(false);
  const [switching, start] = useTransition();
  const { online, newVersion } = useStatus(buildId, initialOnline);
  useEffect(() => setDark(document.documentElement.dataset.theme === 'dark'), []);

  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {}
    setDark(!dark);
  };
  const others = online.filter((o) => o.id !== user.id);
  const current = companies.find((c) => c.id === companyId);

  return (
    <>
      {newVersion && (
        <div className="no-print flex items-center justify-center gap-3 bg-brand px-3 py-1.5 text-sm text-white">
          Dostupna je nova verzija programa.
          <button type="button" onClick={() => window.location.reload()} className="inline-flex items-center gap-1 rounded-md bg-white/20 px-2 py-0.5 font-medium hover:bg-white/30">
            <RefreshCw className="size-3.5" /> Osvježi
          </button>
        </div>
      )}
      <header className="no-print flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 pl-14 sm:gap-3 sm:px-4 lg:pl-4">
        <form
          className="relative w-full max-w-md"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) router.push(`/trazi?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Serijski broj, račun, partner, ugovor…"
            className="h-9 w-full rounded-lg border border-line bg-panel-2 pl-8.5 pr-3 text-base placeholder:text-fg-4 focus:border-brand focus:bg-panel focus:outline-none"
            style={{ paddingLeft: 34 }}
          />
        </form>
        <div className="ml-auto flex items-center gap-1">
          {companies.length > 1 && current && (
            <Menu label={<span className="hidden max-w-40 truncate md:inline">{current.name}</span>} icon={<Building2 className={cn('size-4', switching && 'animate-pulse')} />} title="Prebaci firmu">
              {(close) => (
                <ul>
                  <li className="px-2.5 py-1 text-xs text-fg-3">Firma</li>
                  {companies.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        disabled={c.id === companyId || switching}
                        onClick={() => {
                          close();
                          start(async () => {
                            const r = await switchCompanyAction({ companyId: c.id });
                            if (r.ok) window.location.assign('/');
                          });
                        }}
                        className={cn('w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted', c.id === companyId && 'font-semibold text-brand')}
                      >
                        {c.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Menu>
          )}
          {others.length > 0 && (
            <Menu
              label={<span className="tnum">{others.length}</span>}
              icon={
                <span className="relative">
                  <Users className="size-4" />
                  <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-ok" />
                </span>
              }
              title="Tko je trenutno prijavljen"
            >
              {() => (
                <ul>
                  <li className="px-2.5 py-1 text-xs text-fg-3">Aktivni u zadnjih 5 minuta</li>
                  {others.map((o) => (
                    <li key={o.id} className="flex items-center gap-2 px-2.5 py-1 text-sm">
                      <span className="size-2 rounded-full bg-ok" />
                      {o.name}
                    </li>
                  ))}
                </ul>
              )}
            </Menu>
          )}
          <button type="button" onClick={toggleTheme} className="grid size-8 place-items-center rounded-md text-fg-3 hover:bg-muted" title="Svijetla / tamna tema">
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <Link prefetch={false} href="/postavke/moj-racun" className="hidden rounded-md px-1.5 py-0.5 text-right hover:bg-muted sm:block" title="Moj račun">
            <p className="text-base font-medium leading-tight">{user.name}</p>
            <p className="text-xs text-fg-3">{user.role}</p>
          </Link>
          <Link prefetch={false} href="/postavke/moj-racun" className="grid size-8 place-items-center rounded-md text-fg-3 hover:bg-muted sm:hidden" title="Moj račun">
            <UserRound className="size-4" />
          </Link>
          <button type="button" onClick={() => logout()} className="ml-1 grid size-8 place-items-center rounded-md text-fg-3 hover:bg-muted" title="Odjava">
            <LogOut className="size-4" />
          </button>
        </div>
      </header>
    </>
  );
}
