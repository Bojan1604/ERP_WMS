import { redirect } from 'next/navigation';
import { Wrench } from 'lucide-react';
import { getPortalUser } from '@/server/portal/auth';
import { PortalLoginForm } from './login-form';

export const metadata = { title: 'Prijava' };

export default async function PortalLoginPage() {
  if (await getPortalUser()) redirect('/portal');
  return (
    <main className="grid min-h-dvh place-items-center bg-nav p-4">
      <div className="w-full max-w-sm rounded-2xl bg-panel p-6 shadow-[var(--shadow-pop)] sm:p-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-brand text-white">
            <Wrench className="size-5" />
          </div>
          <div>
            <h1 className="text-lg">Portal za klijente</h1>
            <p className="text-sm text-fg-3">Vaši uređaji, jamstva i prijave kvara</p>
          </div>
        </div>
        <PortalLoginForm />
        <p className="mt-5 text-xs text-fg-3">Podatke za prijavu dobivate od servisa. Zaboravljenu lozinku zatražite od nas — poslat ćemo vam novu.</p>
      </div>
    </main>
  );
}
