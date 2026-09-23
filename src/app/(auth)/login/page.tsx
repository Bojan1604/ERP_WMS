import { Warehouse } from 'lucide-react';
import { LoginForm } from './login-form';

export const metadata = { title: 'Prijava' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="grid min-h-screen place-items-center bg-nav p-4">
      <div className="w-full max-w-sm rounded-2xl bg-panel p-7 shadow-[var(--shadow-pop)]">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-brand text-white">
            <Warehouse className="size-5" />
          </div>
          <div>
            <h1 className="text-lg">ERP · WMS</h1>
            <p className="text-sm text-fg-3">Skladište, prodaja, najam i servis</p>
          </div>
        </div>
        <LoginForm next={next} />
        {process.env.NODE_ENV !== 'production' && (
          <p className="mt-5 text-xs text-fg-3">
            Demo: <b>admin@demo.hr</b> / <b>admin123</b> (i maja@, luka@, ana@, iva@demo.hr s istom lozinkom)
          </p>
        )}
      </div>
    </main>
  );
}
