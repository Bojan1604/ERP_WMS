import 'server-only';
import { headers } from 'next/headers';
import { cookieSecure } from '@/domain/cookie-secure';

/** Secure oznaka za kolačiće prijave prema stvarnom protokolu zahtjeva (vidi domain/cookie-secure). */
export async function secureCookie(): Promise<boolean> {
  return cookieSecure(process.env.COOKIE_SECURE, (await headers()).get('x-forwarded-proto'));
}
