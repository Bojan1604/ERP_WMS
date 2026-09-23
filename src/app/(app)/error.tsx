'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-lg">Nešto je pošlo krivo</h1>
      <p className="mt-2 text-fg-3">{process.env.NODE_ENV === 'development' ? error.message : 'Pokušajte ponovno ili se obratite administratoru.'}</p>
      <button type="button" onClick={reset} className="link mt-4">
        Pokušaj ponovno
      </button>
    </div>
  );
}
