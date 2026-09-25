import 'server-only';
import { createRateLimiter } from '@/domain/portal';

/**
 * Ograničenje pokušaja prijave na portal (kao prijava djelatnika: 5 neuspjeha
 * po adresi → minuta čekanja) i dodatno po IP adresi (20 neuspjeha u 10 min),
 * da se ne mogu pogađati lozinke za mnogo adresa s istog računala.
 */
export const portalLoginByEmail = createRateLimiter({ max: 5, windowMs: 60_000 });
export const portalLoginByIp = createRateLimiter({ max: 20, windowMs: 10 * 60_000 });

/** Prijave kvara po klijentu: najviše 20 u satu (zaštita od slučajnog ili zlonamjernog ponavljanja). */
export const portalReportLimit = createRateLimiter({ max: 20, windowMs: 60 * 60_000 });
