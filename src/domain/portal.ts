/**
 * Portal za klijente — čista logika (bez baze): lozinke, oznake uređaja,
 * javni tijek servisnog naloga i ograničenje pokušaja prijave.
 */

/** Najviše fotografija uz prijavu kvara s portala. */
export const PORTAL_MAX_PHOTOS = 4;

/** Trajanje sesije klijenta portala (dana). */
export const PORTAL_SESSION_DAYS = 30;

/** Filtar jamstva na popisu uređaja: u jamstvu, isteklo, bez podatka. */
export const PORTAL_WARRANTY = { u: 'U jamstvu', isteklo: 'Jamstvo isteklo', bez: 'Bez podatka o jamstvu' } as const;
export type PortalWarranty = keyof typeof PORTAL_WARRANTY;
export const isPortalWarranty = (v: string): v is PortalWarranty => Object.hasOwn(PORTAL_WARRANTY, v);

// bez znakova koji se lako zamijene (0/O, 1/l/I)
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Nasumična lozinka za klijenta (prikazuje se samo jednom). `rand(n)` vraća
 * n nasumičnih bajtova (na poslužitelju `crypto.randomBytes`). Uvijek ima
 * barem jedno malo slovo, veliko slovo i znamenku.
 */
export function generatePortalPassword(rand: (n: number) => Uint8Array, length = 12): string {
  for (;;) {
    const bytes = rand(length * 2);
    let out = '';
    // odbacivanje bajtova iznad najvećeg višekratnika duljine abecede — bez pristranosti
    const limit = 256 - (256 % ALPHABET.length);
    for (const b of bytes) {
      if (b >= limit) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
    if (out.length === length && /[a-z]/.test(out) && /[A-Z]/.test(out) && /[0-9]/.test(out)) return out;
  }
}

/** Vrsta uređaja kod klijenta iz vrste statusa. */
export function portalDeviceKind(state: string, statusName: string): string {
  if (state === 'RENTED') return 'najam';
  if (state === 'SOLD') return 'kupnja';
  return statusName.toLowerCase();
}

/** Stanje uređaja za klijenta (stupac „Stanje" i izvoz). */
export function portalDeviceState(d: { openOrderLabel: string | null; warrantyEnd: string | null }, today: string): string {
  if (d.openOrderLabel) return `u servisu · ${d.openOrderLabel}`;
  if (d.warrantyEnd && d.warrantyEnd >= today) return 'u jamstvu';
  if (d.warrantyEnd) return 'jamstvo isteklo';
  return 'aktivan';
}

/** Dana do kraja jamstva (negativno = isteklo). */
export function daysUntil(end: string, today: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export interface PublicStep {
  at: string;
  status: string;
}

/**
 * Tijek naloga kakav vidi klijent: samo promjene statusa s vremenom — bez
 * imena djelatnika, internih napomena i snimke stanja uređaja. Uzastopni
 * zapisi istog statusa (npr. povrat uređaja) spajaju se u prvi.
 */
export function publicTimeline(raw: unknown, fallback: { at: string; status: string }): PublicStep[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: PublicStep[] = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const { at, status } = e as { at?: unknown; status?: unknown };
    if (typeof at !== 'string' || typeof status !== 'string') continue;
    if (out.at(-1)?.status === status) continue;
    out.push({ at, status });
  }
  return out.length ? out : [fallback];
}

/**
 * Ograničenje neuspjelih pokušaja (u memoriji procesa, kao prijava djelatnika):
 * nakon `max` neuspjeha unutar `windowMs` ključ je zaključan do isteka prozora.
 */
export function createRateLimiter(opts: { max: number; windowMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { n: number; until: number }>();
  return {
    /** Je li ključ trenutno zaključan. */
    blocked(key: string): boolean {
      const h = hits.get(key);
      if (!h) return false;
      if (h.until <= now()) {
        hits.delete(key);
        return false;
      }
      return h.n >= opts.max;
    },
    fail(key: string) {
      const h = hits.get(key);
      const live = h && h.until > now();
      hits.set(key, { n: (live ? h.n : 0) + 1, until: now() + opts.windowMs });
      // da mapa ne raste bez granice (napad s mnogo adresa)
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.until <= now()) hits.delete(k);
    },
    reset(key: string) {
      hits.delete(key);
    },
  };
}
