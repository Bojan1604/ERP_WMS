import 'server-only';
import { randomBytes } from 'node:crypto';
import type { Tx } from '../db';
import { assert } from '../errors';
import { audit } from '../audit';
import { hashPortalPassword as hashPassword } from './session';
import type { Actor } from '../services/items';
import { generatePortalPassword } from '@/domain/portal';

// =============================================================================
//  Pristupi portalu (djelatnik na kartici partnera): dodaj, uredi, uključi/isključi,
//  nova lozinka, obriši. Lozinka se generira i prikazuje samo jednom.
// =============================================================================

export const newPortalPassword = () => generatePortalPassword((n) => randomBytes(n));

async function loadPortalUser(tx: Tx, actor: Actor, id: string) {
  const u = await tx.portalUser.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, email: true, name: true, active: true, partnerId: true, partner: { select: { name: true } } } });
  assert(u, 'Pristup portalu ne postoji.');
  return u;
}

async function assertEmailFree(tx: Tx, companyId: string, email: string, exceptId?: string) {
  // adresa je jedinstvena u cijelom sustavu — za tuđu firmu poruka ne otkriva da adresa postoji
  const other = await tx.portalUser.findUnique({ where: { email }, select: { id: true, companyId: true } });
  if (!other || other.id === exceptId) return;
  assert(other.companyId !== companyId, 'Ta e-adresa već ima pristup portalu.');
  assert(false, 'Ova e-adresa ne može se koristiti za pristup portalu — upišite drugu.');
}

export async function createPortalUser(tx: Tx, actor: Actor, input: { partnerId: string; name: string | null; email: string }) {
  const partner = await tx.partner.findFirst({ where: { id: input.partnerId, companyId: actor.companyId }, select: { id: true, name: true } });
  assert(partner, 'Partner ne postoji.');
  const email = input.email.trim().toLowerCase();
  await assertEmailFree(tx, actor.companyId, email);
  const password = newPortalPassword();
  const u = await tx.portalUser.create({
    data: { companyId: actor.companyId, partnerId: partner.id, email, name: input.name?.trim() || null, passwordHash: await hashPassword(password) },
    select: { id: true, email: true },
  });
  await audit(tx, actor, { entity: 'portalUser', entityId: u.id, action: 'create', summary: `Pristup portalu: ${email} (${partner.name})` });
  return { id: u.id, email: u.email, password };
}

export async function updatePortalUser(tx: Tx, actor: Actor, id: string, input: { name: string | null; email: string }) {
  const u = await loadPortalUser(tx, actor, id);
  const email = input.email.trim().toLowerCase();
  await assertEmailFree(tx, actor.companyId, email, u.id);
  await tx.portalUser.update({ where: { id: u.id }, data: { email, name: input.name?.trim() || null } });
  // promjena adrese za prijavu odjavljuje postojeće sesije
  if (email !== u.email) await tx.portalSession.updateMany({ where: { portalUserId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(tx, actor, {
    entity: 'portalUser',
    entityId: u.id,
    action: 'update',
    summary: `Pristup portalu izmijenjen: ${email} (${u.partner.name})`,
    diff: email !== u.email ? { email: { from: u.email, to: email } } : undefined,
  });
}

export async function setPortalUserActive(tx: Tx, actor: Actor, id: string, active: boolean) {
  const u = await loadPortalUser(tx, actor, id);
  await tx.portalUser.update({ where: { id: u.id }, data: { active } });
  if (!active) await tx.portalSession.updateMany({ where: { portalUserId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(tx, actor, { entity: 'portalUser', entityId: u.id, action: active ? 'enable' : 'disable', summary: `Pristup portalu ${active ? 'uključen' : 'isključen'}: ${u.email} (${u.partner.name})` });
}

export async function resetPortalPassword(tx: Tx, actor: Actor, id: string) {
  const u = await loadPortalUser(tx, actor, id);
  const password = newPortalPassword();
  await tx.portalUser.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(password) } });
  await tx.portalSession.updateMany({ where: { portalUserId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(tx, actor, { entity: 'portalUser', entityId: u.id, action: 'password', summary: `Nova lozinka za portal: ${u.email} (${u.partner.name})` });
  return { email: u.email, password };
}

/** Brisanje pristupa; prijave kvara ostaju (portalUserId → null). */
export async function deletePortalUser(tx: Tx, actor: Actor, id: string) {
  const u = await loadPortalUser(tx, actor, id);
  await tx.portalUser.delete({ where: { id: u.id } });
  await audit(tx, actor, { entity: 'portalUser', entityId: u.id, action: 'delete', summary: `Pristup portalu obrisan: ${u.email} (${u.partner.name})` });
}

/** Pristupi portalu jednog partnera (za stranicu /partneri/[id]/portal). */
export function listPartnerPortalUsers(tx: Pick<Tx, 'portalUser'>, companyId: string, partnerId: string) {
  return tx.portalUser.findMany({
    where: { companyId, partnerId },
    orderBy: [{ createdAt: 'asc' }],
    select: { id: true, name: true, email: true, active: true, lastLoginAt: true, createdAt: true },
  });
}
