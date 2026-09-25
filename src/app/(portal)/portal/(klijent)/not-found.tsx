import Link from 'next/link';

/** Nepostojeća prijava ili uređaj unutar portala — ostaje u okviru portala, bez poveznice na program. */
export default function PortalNotFound() {
  return (
    <div className="grid min-h-[40vh] place-items-center p-6 text-center">
      <div>
        <h1 className="text-xl">Zapis ne postoji</h1>
        <p className="mt-2 text-fg-3">Prijava je možda obrisana ili poveznica nije ispravna.</p>
        <Link prefetch={false} href="/portal" className="link mt-4 inline-block">
          Natrag na moje uređaje
        </Link>
      </div>
    </div>
  );
}
