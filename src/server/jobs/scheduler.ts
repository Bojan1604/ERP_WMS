import 'server-only';
import { runAutoBackups } from './backups';
import { runAutoIssue } from './auto-issue';

/**
 * Pozadinski poslovi (pokreće ih src/instrumentation.ts jednom po procesu):
 *  - automatsko izdavanje rata najma (od 6:00 po zagrebačkom vremenu, jednom dnevno po firmi),
 *  - automatska sigurnosna kopija (od 2:00, jednom dnevno po firmi).
 * Provjera svakih 15 minuta; svaki posao sam osigurava da se dnevno izvrši jednom
 * i kad radi više procesa (advisory lock / atomska prijava u bazi).
 * Isključivanje: JOBS_DISABLED=1 (npr. dodatne instance koje služe samo zahtjeve).
 */
const EVERY_MS = 15 * 60_000;
const g = globalThis as unknown as { __erpJobs?: ReturnType<typeof setInterval> };

const zagrebHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zagreb', hour: '2-digit', hour12: false }).format(d));

let running = false;

export async function tick(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const h = zagrebHour(now);
    if (h >= 2) {
      const r = await runAutoBackups(now);
      for (const x of r) if (!x.ok) console.error('[poslovi] kopija nije uspjela', x.companyId, x.error);
    }
    if (h >= 6) {
      const r = await runAutoIssue();
      for (const x of r) if (x.issued.length || x.errors.length) console.info(`[poslovi] ${x.companyName}: izdano ${x.issued.length}, grešaka ${x.errors.length}`);
    }
  } catch (e) {
    console.error('[poslovi]', e);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (process.env.JOBS_DISABLED === '1' || g.__erpJobs) return;
  // prvi krug malo nakon pokretanja (poslužitelj se najprije zagrije)
  setTimeout(() => void tick(), 60_000).unref?.();
  g.__erpJobs = setInterval(() => void tick(), EVERY_MS);
  g.__erpJobs.unref?.();
}
