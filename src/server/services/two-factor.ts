import 'server-only';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import type { Tx } from '../db';
import { audit } from '../audit';
import { assert } from '../errors';
import { env } from '../env';
import { decryptSecret, encryptSecret } from '../fiscal/crypto';
import type { Actor } from './items';

/**
 * Prijava u dva koraka (TOTP, RFC 6238): tajna je u bazi šifrirana
 * (`encryptSecret`, AES-GCM iz AUTH_SECRET), rezervni kodovi samo kao sha256
 * sažeci — iskorišteni se brišu. Tolerancija ±30 s (jedan korak) za neusklađen sat mobitela.
 */
export const TOTP_ISSUER = 'ERP · WMS';
export const BACKUP_CODE_COUNT = 10;
/** Koliko dugo vrijedi prvi korak prijave (lozinka ispravna, čeka se kod). */
export const CHALLENGE_TTL_MS = 5 * 60_000;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Rezervni kod bez razmaka i crtica, mala slova. */
export const normalizeBackupCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

export function generateBackupCodes(n = BACKUP_CODE_COUNT): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: n }, () => {
    const h = randomBytes(5).toString('hex'); // 10 znakova
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
  return { plain, hashes: plain.map((c) => sha(normalizeBackupCode(c))) };
}

/** Provjera šesteroznamenkastog koda (±1 korak od 30 s). */
export async function verifyTotpCode(secret: string, code: string, epoch?: number): Promise<boolean> {
  const token = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) return false;
  try {
    const r = await verify({ secret, token, epochTolerance: 30, ...(epoch !== undefined ? { epoch } : {}) });
    return r.valid;
  } catch {
    return false;
  }
}

/** Korak 1 uključivanja: nova tajna (još neaktivna) + QR kod za aplikaciju. */
export async function startTotpSetup(tx: Tx, actor: Actor) {
  const u = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { email: true, totpEnabled: true } });
  assert(!u.totpEnabled, 'Prijava u dva koraka je već uključena.');
  const secret = generateSecret();
  await tx.user.update({ where: { id: actor.id }, data: { totpSecret: encryptSecret(secret) } });
  const uri = generateURI({ issuer: TOTP_ISSUER, label: u.email, secret });
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return { secret, uri, qr };
}

/** Korak 2: potvrda kodom iz aplikacije — uključuje 2FA i vraća rezervne kodove (prikazuju se samo jednom). */
export async function confirmTotpSetup(tx: Tx, actor: Actor, code: string) {
  const u = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { totpSecret: true, totpEnabled: true } });
  assert(!u.totpEnabled, 'Prijava u dva koraka je već uključena.');
  const secret = decryptSecret(u.totpSecret);
  assert(secret, 'Najprije pokrenite uključivanje (skenirajte QR kod).');
  assert(await verifyTotpCode(secret, code), 'Kod nije ispravan — provjerite vrijeme na mobitelu i upišite novi kod.');
  const codes = generateBackupCodes();
  await tx.user.update({ where: { id: actor.id }, data: { totpEnabled: true, backupCodes: codes.hashes } });
  await audit(tx, actor, { entity: 'user', entityId: actor.id, action: '2fa-on', summary: 'Uključena prijava u dva koraka' });
  return codes.plain;
}

/** Novi rezervni kodovi (stari prestaju vrijediti). Traži važeći kod iz aplikacije. */
export async function regenerateBackupCodes(tx: Tx, actor: Actor, code: string) {
  const u = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { totpSecret: true, totpEnabled: true } });
  assert(u.totpEnabled && u.totpSecret, 'Prijava u dva koraka nije uključena.');
  assert(await verifyTotpCode(decryptSecret(u.totpSecret)!, code), 'Kod nije ispravan.');
  const codes = generateBackupCodes();
  await tx.user.update({ where: { id: actor.id }, data: { backupCodes: codes.hashes } });
  await audit(tx, actor, { entity: 'user', entityId: actor.id, action: '2fa-codes', summary: 'Izdani novi rezervni kodovi za prijavu u dva koraka' });
  return codes.plain;
}

/** Isključivanje vlastite 2FA — uz lozinku. */
export async function disableOwnTotp(tx: Tx, actor: Actor, password: string) {
  const u = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { passwordHash: true, totpEnabled: true } });
  assert(u.totpEnabled, 'Prijava u dva koraka nije uključena.');
  assert(await bcrypt.compare(password, u.passwordHash), 'Lozinka nije ispravna.');
  await tx.user.update({ where: { id: actor.id }, data: { totpEnabled: false, totpSecret: null, backupCodes: [] } });
  await audit(tx, actor, { entity: 'user', entityId: actor.id, action: '2fa-off', summary: 'Isključena prijava u dva koraka' });
}

/**
 * Administrator poništava 2FA korisniku (izgubljen mobitel i kodovi): korisnik se
 * sljedeći put prijavljuje samo lozinkom i može ponovno uključiti 2FA. Sve sesije se odjavljuju.
 */
export async function resetUserTotp(tx: Tx, actor: Actor, userId: string, companyId: string) {
  const u = await tx.user.findFirst({ where: { id: userId, OR: [{ companyId }, { companies: { some: { companyId } } }] }, select: { name: true, totpEnabled: true, totpSecret: true } });
  assert(u, 'Korisnik ne postoji.');
  assert(u.totpEnabled || u.totpSecret, `${u.name} nema uključenu prijavu u dva koraka.`);
  await tx.user.update({ where: { id: userId }, data: { totpEnabled: false, totpSecret: null, backupCodes: [] } });
  await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(tx, actor, { entity: 'user', entityId: userId, action: '2fa-reset', summary: `Poništena prijava u dva koraka za ${u.name} — odjavljen sa svih uređaja` });
}

/**
 * Drugi korak prijave: TOTP kod ili rezervni kod (iskorišteni rezervni kod se
 * briše atomski — dvije istovremene prijave istim kodom ne prolaze obje).
 */
export async function checkSecondFactor(tx: Tx, userId: string, code: string): Promise<'totp' | 'backup' | null> {
  const u = await tx.user.findUnique({ where: { id: userId }, select: { totpEnabled: true, totpSecret: true, backupCodes: true } });
  if (!u?.totpEnabled || !u.totpSecret) return null;
  const clean = code.trim();
  if (/^\d{6}$/.test(clean.replace(/\s/g, ''))) return (await verifyTotpCode(decryptSecret(u.totpSecret)!, clean)) ? 'totp' : null;
  const h = sha(normalizeBackupCode(clean));
  if (!u.backupCodes.includes(h)) return null;
  const n = await tx.$executeRaw`UPDATE "User" SET "backupCodes" = array_remove("backupCodes", ${h}) WHERE id = ${userId} AND ${h} = ANY("backupCodes")`;
  return n ? 'backup' : null;
}

// ---------------------------------------------------------------- izazov između dva koraka

/**
 * Potpisan izazov (HMAC s AUTH_SECRET) u kratkotrajnom kolačiću: nosi id
 * korisnika i istek. Bez njega drugi korak ne postoji — lozinka se ne šalje dvaput.
 */
export function signChallenge(userId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: now + CHALLENGE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
  const mac = createHmac('sha256', env().AUTH_SECRET).update(`2fa:${payload}`).digest('base64url');
  return `${payload}.${mac}`;
}

export function readChallenge(token: string | undefined, now = Date.now()): string | null {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const want = createHmac('sha256', env().AUTH_SECRET).update(`2fa:${payload}`).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: unknown; e?: unknown };
    if (typeof o.u !== 'string' || typeof o.e !== 'number' || o.e < now) return null;
    return o.u;
  } catch {
    return null;
  }
}
