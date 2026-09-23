import Link from 'next/link';
import { MODULES, type Module } from '@/domain/permissions';

export default async function Forbidden({ searchParams }: { searchParams: Promise<{ modul?: string }> }) {
  const { modul } = await searchParams;
  const name = modul && modul in MODULES ? MODULES[modul as Module] : 'ovaj dio programa';
  return (
    <main className="grid min-h-screen place-items-center p-6 text-center">
      <div>
        <h1 className="text-xl">Nemate pristup</h1>
        <p className="mt-2 text-fg-3">Vaša uloga nema pravo na modul „{name}". Obratite se administratoru.</p>
        <Link href="/" className="link mt-4 inline-block">
          Natrag na početnu
        </Link>
      </div>
    </main>
  );
}
