import 'server-only';
import { headers } from 'next/headers';
import { db } from '../db';
import bcrypt from 'bcryptjs';
import { parseTrustProxy, pickClientIp } from '@/domain/client-ip';

/**
 * Ograničenje pokušaja prijave (djelatnici i portal) u bazi (`LoginAttempt`) —
 * vrijedi za sve procese i preživljava ponovno pokretanje. Pokušaj se upisuje
 * PRIJE provjere lozinke (pod bravom ključa), pa istodobni zahtjevi ne mogu zaobići
 * granicu; odbijeni (zaključani) pokušaj se ne pamti, pa broj redaka po ključu ostaje ograničen.
 * Stari zapisi (stariji od dana) brišu se usput.
 */
export interface LoginLimit {
  key: string;
  max: number;
  windowMs: number;
}

export const LOGIN_LIMITS = {
  /** 5 neuspjeha po adresi (ili po korisniku u drugom koraku) u minuti → čekanje do isteka minute. */
  account: { max: 5, windowMs: 60_000 },
  /**
   * 50 neuspjelih pokušaja s iste IP adrese u 10 minuta (pogađanje lozinki za mnogo adresa).
   * Prag je viši od broja korisnika jednog ureda iza iste javne adrese, pa nekoliko
   * zatipkanih lozinki ne zaključa i administratora; uspješna prijava briše svoj pokušaj.
   */
  ip: { max: 50, windowMs: 10 * 60_000 },
} as const;

/** Poruka za zaključanu prijavu s točnim preostalim vremenom. */
export function tooManyMessage(retryAfterMs: number): string {
  const s = Math.max(1, Math.ceil(retryAfterMs / 1000));
  if (s < 60) return `Previše neuspjelih pokušaja. Pokušajte ponovno za ${s} s.`;
  const m = Math.ceil(s / 60);
  return `Previše neuspjelih pokušaja. Pokušajte ponovno za ${m} ${m === 1 ? 'minutu' : m < 5 ? 'minute' : 'minuta'}.`;
}

/** Ključevi za prijavu: po adresi (ili korisniku) i po IP adresi. */
export function loginKeys(scope: 'staff' | 'portal' | '2fa', account: string, ip: string | null): LoginLimit[] {
  return [
    { key: `${scope}:acc:${account.slice(0, 200)}`, ...LOGIN_LIMITS.account },
    { key: `${scope}:ip:${ip ?? 'unknown'}`, ...LOGIN_LIMITS.ip },
  ];
}

export interface Attempt {
  /** Pokušaj je dopušten (nije prekoračena granica ni po jednom ključu). */
  allowed: boolean;
  ids: string[];
  keys: LoginLimit[];
  /** Zaključano: za koliko ms se prijava ponovno dopušta (0 kad je dopušteno). */
  retryAfterMs: number;
  /** Poruka korisniku kad pokušaj nije dopušten (s preostalim vremenom). */
  message: string;
}

const CLEANUP_EVERY_MS = 10 * 60_000;
let lastCleanup = 0;

/** Briše pokušaje starije od dana (najviše jednom u 10 minuta po procesu). */
export async function cleanupLoginAttempts(force = false, now = Date.now()) {
  if (!force && now - lastCleanup < CLEANUP_EVERY_MS) return 0;
  lastCleanup = now;
  const r = await db.loginAttempt.deleteMany({ where: { at: { lt: new Date(now - 86_400_000) } } });
  return r.count;
}

/**
 * Upis pokušaja i provjera granica. Po ključu se uzima kratka transakcijska brava
 * (pg_advisory_xact_lock), pa istodobni zahtjevi prolaze točno do granice — ni više,
 * ni manje. Kad pokušaj nije dopušten, ne upisuje se.
 */
export async function beginAttempt(keys: LoginLimit[]): Promise<Attempt> {
  void cleanupLoginAttempts().catch(() => undefined);
  return db.$transaction(
    async (tx) => {
      // brave uvijek istim redom (bez potpunog zastoja između dva zahtjeva)
      for (const k of [...keys].sort((a, b) => a.key.localeCompare(b.key))) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`login:${k.key}`}))`;
      const now = Date.now();
      const counts = await Promise.all(keys.map((k) => tx.loginAttempt.count({ where: { key: k.key, at: { gt: new Date(now - k.windowMs) } } })));
      if (counts.some((n, i) => n >= keys[i].max)) {
        // otključava se kad iz prozora izađe pokušaj zbog kojeg je broj dosegnuo granicu
        let until = now;
        for (const [i, k] of keys.entries()) {
          if (counts[i] < k.max) continue;
          const pivot = await tx.loginAttempt.findFirst({
            where: { key: k.key, at: { gt: new Date(now - k.windowMs) } },
            orderBy: { at: 'desc' },
            skip: k.max - 1,
            select: { at: true },
          });
          until = Math.max(until, (pivot?.at.getTime() ?? now) + k.windowMs);
        }
        const retryAfterMs = Math.max(1000, until - now);
        return { allowed: false, ids: [], keys, retryAfterMs, message: tooManyMessage(retryAfterMs) };
      }
      const ids: string[] = [];
      for (const k of keys) ids.push((await tx.loginAttempt.create({ data: { key: k.key }, select: { id: true } })).id);
      return { allowed: true, ids, keys, retryAfterMs: 0, message: '' };
    },
    { maxWait: 10_000, timeout: 10_000 },
  );
}

/** Uspješna prijava: brišu se neuspjesi računa (ključ adrese) i ovaj pokušaj s IP-a. */
export async function succeedAttempt(a: Attempt) {
  await db.loginAttempt.deleteMany({ where: { OR: [{ id: { in: a.ids } }, { key: a.keys[0].key }] } });
}

// sažetak za usporedbu kad korisnik ne postoji — isto trajanje odgovora (ne odaje se koje adrese postoje)
let dummy: Promise<string> | null = null;
export async function dummyPasswordCheck(password: string) {
  // isti trošak kao hashPassword/verifyPassword u auth.ts (bcrypt, 10 krugova)
  await bcrypt.compare(password, await (dummy ??= bcrypt.hash('dummy-password-for-timing', 10)));
  return false;
}

/** Adresa klijenta prema TRUST_PROXY (zadano 1 posrednik: zadnji unos X-Forwarded-For koji dodaje Caddy). */
export async function requestIp(): Promise<string | null> {
  const h = await headers();
  return pickClientIp(h.get('x-forwarded-for'), parseTrustProxy(process.env.TRUST_PROXY));
}
