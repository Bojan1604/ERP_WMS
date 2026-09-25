/**
 * Next.js poziva `register` jednom pri pokretanju poslužitelja. Pozadinski
 * poslovi (automatsko izdavanje rata, dnevna sigurnosna kopija) rade samo u
 * Node okruženju (ne u Edge middlewareu) i ne pri `next build`.
 * Uvoz mora biti unutar `if (NEXT_RUNTIME === 'nodejs')` — tako ga Edge build izbacuje.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { startScheduler } = await import('./server/jobs/scheduler');
    startScheduler();
  }
}
