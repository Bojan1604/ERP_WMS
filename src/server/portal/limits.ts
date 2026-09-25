import 'server-only';
import { createRateLimiter } from '@/domain/portal';

// Ograničenje pokušaja prijave na portal je u bazi: services/login-attempts.ts.

/** Prijave kvara po klijentu: najviše 20 u satu (zaštita od slučajnog ili zlonamjernog ponavljanja). */
export const portalReportLimit = createRateLimiter({ max: 20, windowMs: 60 * 60_000 });
