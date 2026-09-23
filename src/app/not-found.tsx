import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="grid min-h-[60vh] place-items-center p-6 text-center">
      <div>
        <h1 className="text-xl">Stranica ne postoji</h1>
        <p className="mt-2 text-fg-3">Zapis je možda obrisan ili poveznica nije ispravna.</p>
        <Link prefetch={false} href="/" className="link mt-4 inline-block">
          Natrag na početnu
        </Link>
      </div>
    </main>
  );
}
