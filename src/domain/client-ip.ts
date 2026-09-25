/**
 * Adresa klijenta iza reverznog posrednika (Caddy). Prvi unos X-Forwarded-For
 * upisuje klijent sam, pa mu se ne vjeruje: koristi se unos koji je dodao naš
 * posrednik — `trust` skokova od kraja (Caddy dodaje adresu s koje je spojen
 * klijent na kraj popisa). `trust = 0` („none"): zaglavlju se ne vjeruje.
 */
export function parseTrustProxy(v: string | undefined): number {
  const s = (v ?? '').trim().toLowerCase();
  if (!s) return 1;
  if (s === 'none' || s === 'false' || s === 'off') return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

/** Adresa iz X-Forwarded-For uz `trust` posrednika; null kad joj se ne može vjerovati. */
export function pickClientIp(xff: string | null | undefined, trust: number): string | null {
  if (trust <= 0 || !xff) return null;
  const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
  const ip = hops[hops.length - trust];
  if (!ip) return null;
  return ip.replace(/^::ffff:/, '').slice(0, 64) || null;
}
