import Link from 'next/link';
import { LogOut } from 'lucide-react';
import { MODULES, type Module } from '@/domain/permissions';
import { requireUser, userHome } from '@/server/auth';
import { logout } from '@/app/(auth)/login/actions';

export const metadata = { title: 'Nemate pristup' };

/** Stranica zabrane unutar aplikacije (izbornik i odjava ostaju); „Početna" vodi na prvi dopušteni modul. */
export default async function Forbidden({ searchParams }: { searchParams: Promise<{ modul?: string }> }) {
  const user = await requireUser();
  const { modul } = await searchParams;
  const name = modul && modul in MODULES ? MODULES[modul as Module] : 'ovaj dio programa';
  return (
    <div className="grid min-h-[60vh] place-items-center p-6 text-center">
      <div>
        <h1 className="text-xl">Nemate pristup</h1>
        <p className="mt-2 text-fg-3">Vaša uloga nema pravo na modul „{name}". Obratite se administratoru.</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-4">
          <Link prefetch={false} href={userHome(user)} className="link">
            Natrag na početnu
          </Link>
          <form action={logout}>
            <button type="submit" className="link inline-flex items-center gap-1">
              <LogOut className="size-4" /> Odjava
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
