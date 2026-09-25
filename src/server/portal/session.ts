import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db';
import type { Actor } from '../services/items';
import { PORTAL_SESSION_DAYS } from '@/domain/portal';

// =============================================================================
//  Prijava klijenata na portal — zasebna tablica korisnika (PortalUser), zasebna
//  sesija (PortalSession) i kolačić koji vrijedi samo za /portal. Djelatnička
//  sesija ne otvara portal i obrnuto. Ovdje je samo rad s bazom (bez zahtjeva),
//  kolačić je u ./auth.ts.
// =============================================================================

/** bcrypt, isto kao lozinke djelatnika (server/auth.ts). */
export const hashPortalPassword = (plain: string) => bcrypt.hash(plain, 10);
const verifyPassword = (plain: string, h: string) => bcrypt.compare(plain, h);
const hashPassword = hashPortalPassword;

/** Prijavljeni klijent portala: uvijek vezan na jednog partnera jedne firme. */
export interface PortalUser {
  id: string;
  name: string | null;
  email: string;
  companyId: string;
  companyName: string;
  partnerId: string;
  partnerName: string;
}

/** Ono što upiti portala trebaju: firma i partner (svaki upit je sužen na oba). */
export type PortalScope = Pick<PortalUser, 'id' | 'companyId' | 'partnerId'> & { name: string | null; email: string };

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

// sažetak za usporedbu kad korisnik ne postoji — isto trajanje odgovora, pa se ne odaje koje adrese postoje
let dummyHash: Promise<string> | null = null;

/** Provjera e-adrese i lozinke; `null` za nepostojećeg, isključenog ili krivu lozinku. */
export async function authenticatePortalUser(email: string, password: string) {
  const u = await db.portalUser.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, passwordHash: true, active: true } });
  if (!u) {
    await verifyPassword(password, await (dummyHash ??= hashPassword('portal-dummy-password')));
    return null;
  }
  const ok = await verifyPassword(password, u.passwordHash);
  if (!ok || !u.active) return null;
  return { id: u.id };
}

/** Nova sesija: nasumičan token (u bazi samo sažetak) i upis zadnje prijave. */
export async function createPortalSession(portalUserId: string, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PORTAL_SESSION_DAYS * 86_400_000);
  await db.$transaction([
    db.portalSession.create({ data: { portalUserId, tokenHash: sha(token), expiresAt, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null } }),
    db.portalUser.update({ where: { id: portalUserId }, data: { lastLoginAt: new Date() }, select: { id: true } }),
  ]);
  return { token, expiresAt };
}

/** Klijent iz tokena sesije — `null` ako je sesija istekla/opozvana ili je pristup isključen. */
export async function resolvePortalSession(token: string | null | undefined): Promise<PortalUser | null> {
  if (!token) return null;
  const s = await db.portalSession.findUnique({
    where: { tokenHash: sha(token) },
    select: {
      revokedAt: true,
      expiresAt: true,
      portalUser: {
        select: {
          id: true, name: true, email: true, active: true, companyId: true, partnerId: true,
          company: { select: { name: true } },
          partner: { select: { name: true, companyId: true } },
        },
      },
    },
  });
  if (!s || s.revokedAt || s.expiresAt < new Date()) return null;
  const u = s.portalUser;
  // partner mora biti iz iste firme (zaštita od pogrešno upisanog zapisa)
  if (!u.active || u.partner.companyId !== u.companyId) return null;
  return { id: u.id, name: u.name, email: u.email, companyId: u.companyId, companyName: u.company.name, partnerId: u.partnerId, partnerName: u.partner.name };
}

export async function revokePortalSession(token: string | null | undefined) {
  if (!token) return;
  await db.portalSession.updateMany({ where: { tokenHash: sha(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Izvršitelj za servisni sloj i dnevnik promjena (ime s oznakom portala). */
export const portalActor = (u: PortalScope): Actor => ({ id: u.id, name: `${u.name || u.email} (portal)`, companyId: u.companyId });
