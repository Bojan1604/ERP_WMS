'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LogOut, Moon, Search, Sun } from 'lucide-react';
import { logout } from '@/app/(auth)/login/actions';

export function Topbar({ user }: { user: { name: string; role: string } }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.dataset.theme === 'dark'), []);

  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {}
    setDark(!dark);
  };

  return (
    <header className="no-print flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-4 pl-14 lg:pl-4">
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
        <button type="button" onClick={toggleTheme} className="grid size-8 place-items-center rounded-md text-fg-3 hover:bg-muted" title="Svijetla / tamna tema">
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
        <div className="hidden text-right sm:block">
          <p className="text-base font-medium leading-tight">{user.name}</p>
          <p className="text-xs text-fg-3">{user.role}</p>
        </div>
        <button type="button" onClick={() => logout()} className="ml-1 grid size-8 place-items-center rounded-md text-fg-3 hover:bg-muted" title="Odjava">
          <LogOut className="size-4" />
        </button>
      </div>
    </header>
  );
}
